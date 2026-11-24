import { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentHistory } from "../src/components/DocumentHistory";
import { DocumentWorkspace, type HistoryEditTarget } from "../src/components/DocumentWorkspace";
import { CARD_LINK_NODE } from "../src/domain/document/cardLinks";
import { decodeCardClipboardPayload, pasteCardClipboardPayload } from "../src/domain/document/clipboard";
import { contentJsonForPlainText, replaceCardContent } from "../src/domain/document/content";
import type { WorkspacePane } from "../src/domain/document/manuscriptLayout";
import { proseExtensions } from "../src/domain/document/manuscriptMarkdown";
import { latestRevisionId, toEditableDocumentSnapshot } from "../src/domain/document/serialization";
import { createChildCard, deleteCardSubtree } from "../src/domain/document/tree";
import { useInteractionStore } from "../src/state/interactionStore";
import { useDocumentStore } from "../src/state/documentStore";
import type { HistoryComparison, HistoryEntry, HistoryPage } from "../src/storage/documentHistory";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), flush: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => false }));
vi.mock("../src/storage/forceSave", () => ({ forceSaveCurrentDocument: mocks.flush }));

const archive: HistoryEntry[] = Array.from({ length: 24 }, (_, index) => ({
  id: `rev-${24 - index}`, createdAtMs: (24 - index) * 1000, sequence: 24 - index,
}));
const earlier = replaceCardContent(makeDocumentSnapshot(), {
  cardId: "card-a",
  contentJson: contentJsonForPlainText("Deleted branch"),
});
earlier.manuscript = {
  id: "be9e3754-e23e-41d5-9aca-ded015dfc6a1",
  contentJson: JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Earlier manuscript", marks: [{ type: "bold" }] }] }],
  }),
  passages: [{ id: "5cf6689c-02cb-4574-9d68-2c6270982777", from: 1, to: 8, targetCardIds: ["card-a"] }],
};

function Harness({ narrow = false, keepLiveMounted = false }: { narrow?: boolean; keepLiveMounted?: boolean }) {
  const snapshot = useDocumentStore((state) => state.snapshot)!;
  const [pane, setPane] = useState<WorkspacePane>("tree");
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(true);
  const [editTarget, setEditTarget] = useState<(HistoryEditTarget & { startEditing: true }) | null>(null);
  function close() {
    useDocumentStore.getState().setHistoricalPreview(false);
    setOpen(false);
  }
  return <>
    {keepLiveMounted && <div hidden={open}>
      <DocumentWorkspace document={snapshot.summary} historyPaneRequest={editTarget} />
    </div>}
    {!open && !keepLiveMounted && <div>Live {pane}</div>}
    {open && <DocumentHistory document={snapshot.summary} current={snapshot}
      session={useDocumentStore.getState().session} pane={pane} narrow={narrow} surfaceVisible={visible}
      shortcutsSuspended={false} onPane={setPane} onSurfaceVisible={setVisible} onRestore={(target) => {
        setEditTarget({ ...target, startEditing: true });
        close();
      }} onClose={close} />}
  </>;
}

describe("History timeline and recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let entries: HistoryEntry[];
  let historyHead: HistoryEntry | null;
  let live: ReturnType<typeof makeDocumentSnapshot>;
  let historical: ReturnType<typeof makeDocumentSnapshot>;
  let maintenanceAtMs: number | null;
  let comparisons: Record<string, HistoryComparison>;
  let visibleEntries: HistoryEntry[] | null;
  let previousVisible: HistoryPage["previousVisible"];

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem("fablecraft.workspace.doc-1");
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    entries = [...archive];
    historyHead = { id: "live-head", createdAtMs: 25_000, sequence: 25 };
    maintenanceAtMs = null;
    comparisons = {};
    visibleEntries = null;
    previousVisible = {};
    useInteractionStore.getState().setActiveCardId(null);
    historical = earlier;
    live = { ...deleteCardSubtree(earlier, "card-a"), manuscript: undefined, revisions: [historyHead] };
    useDocumentStore.getState().hydrateSnapshot(live);
    mocks.flush.mockReset().mockResolvedValue(null);
    mocks.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "list_document_history") {
        const visible = visibleEntries ?? entries;
        const matching = visible.filter((entry) => !args.before || entry.sequence < args.before.sequence);
        return {
          entries: matching.slice(0, 10), hasMore: matching.length > 10,
          headId: historyHead?.id ?? null, maintenanceAtMs,
          previousVisible,
          selectedRetained: !args.selected || entries.some(({ id }) => id === args.selected),
        };
      }
      if (command === "compare_document_history") {
        return Object.fromEntries((args.revisionIds as string[]).map((id) => [
          id, comparisons[id] ?? { status: "compared", changes: [] },
        ]));
      }
      if (command === "load_historical_snapshot") return toEditableDocumentSnapshot(historical);
      if (command === "load_current_document") return live;
      if (command === "load_current_document_clock") return { documentId: live.summary.documentId, updatedAtMs: 1, fileModifiedAtMs: 1 };
      if (command === "list_current_document_directory") {
        return { currentDocumentPath: live.summary.path, entries: [], folderName: "tmp", folderPath: "/tmp", parentFolderPath: "/" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useDocumentStore.getState().clearDocument();
    container.remove();
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  function button(text: string) {
    return [...container.querySelectorAll("button")].find((element) => element.textContent === text)!;
  }

  async function click(element: HTMLButtonElement) {
    await act(async () => element.click());
  }

  async function key(key: string, target: EventTarget = window, modifiers?: KeyboardEventInit) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
    });
  }

  async function open(narrow = false) {
    await act(async () => root.render(<Harness narrow={narrow} />));
  }

  function row(index: number) {
    return container.querySelectorAll<HTMLButtonElement>("[data-history-entry]")[index]!;
  }

  it("shows Current even when the document has never saved", async () => {
    entries = [];
    historyHead = null;
    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());
    await open();
    expect(row(0).getAttribute("aria-current")).toBe("true");
    expect(container.textContent).toContain("There are no earlier snapshots to browse.");
  });

  it.each([false, true])("compares Current to the next card with or without the head in the listing (%s)", async (includesHead) => {
    visibleEntries = includesHead ? [historyHead!, ...entries.slice(1, 3)] : entries.slice(1, 3);
    previousVisible["rev-23"] = "rev-22";
    comparisons["live-head"] = { status: "compared", changes: [
      { description: "Text edited in B02", kind: "cardEdited", card: { id: "card-b", label: "B02" },
        characters: { added: 12, removed: 3 } },
    ] };

    await open();

    expect(row(0).textContent).toContain("Current");
    expect(row(0).querySelector(".fc-history-card-symbol")?.textContent).toBe("B02");
    expect(row(0).querySelector(".fc-history-character-total")?.textContent).toContain("+12");
    expect(row(0).querySelector(".fc-history-character-total")?.textContent).toContain("−3");
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(3);
    expect(mocks.invoke.mock.calls).toContainEqual(["compare_document_history", expect.objectContaining({
      baselines: { "live-head": "rev-23", "rev-23": "rev-22" },
    })]);
  });

  it("closes using the icon button with an accessible label", async () => {
    await open();
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close History"]')!;
    expect(close.textContent).toBe("×");
    await click(close);
    expect(container.textContent).toBe("Live tree");
  });

  it("pages more than 20 snapshots and switches the same read-only snapshot between panes", async () => {
    const createdAtMs = 500;
    useDocumentStore.getState().hydrateSnapshot({ ...live, summary: { ...live.summary, createdAtMs } });
    comparisons["rev-1"] = { status: "initial" };
    await open();
    expect(document.activeElement).toBe(row(0));
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(11);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(21);
    expect(container.querySelector(".fc-history-created")).toBeNull();
    await click(button("Load Older Snapshots"));
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(25);
    expect(row(24).textContent).toContain("Earliest retained snapshot");
    const footer = row(24).nextElementSibling;
    expect(footer?.tagName).toBe("P");
    expect(footer?.textContent).toContain("Document created");
    expect(footer?.querySelector("time")?.dateTime).toBe(new Date(createdAtMs).toISOString());
    await click(row(24));
    expect(container.textContent).toContain("Deleted branch");
    expect(useDocumentStore.getState().snapshot?.cards.some(({ id }) => id === "card-a")).toBe(false);

    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await key("ArrowRight", window, { altKey: true, metaKey: apple, ctrlKey: !apple });
    expect(container.querySelector(".fc-manuscript-pane:not([hidden]) .fc-manuscript-editor strong")?.textContent).toBe("Earlier manuscript");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "load_historical_snapshot")).toEqual([
      ["load_historical_snapshot", { path: live.summary.path, documentId: live.summary.documentId, revisionId: "rev-1" }],
    ]);
    expect(useDocumentStore.getState().dirty).toBe(false);
    expect(container.querySelector("[contenteditable=true]")).toBeNull();
    await key("Escape");
    expect(container.textContent).toBe("Live manuscript");
  });

  it.each([false, true])("moves keyboard focus between snapshots and the read-only tree (narrow=%s)", async (narrow) => {
    historical = createChildCard(historical, "card-root", "extra-child");
    await open(narrow);
    await key("ArrowDown", document.activeElement!);
    await key("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(row(2));
    expect(row(2).getAttribute("aria-current")).toBe("true");
    await key("Enter", document.activeElement!);

    const stage = container.querySelector<HTMLElement>('[data-testid="document-stage"]')!;
    expect(document.activeElement).toBe(stage);
    await key("ArrowRight", stage);
    expect(stage.querySelector('[data-testid="active-card-shell"]')?.getAttribute("data-manuscript-target")).toBe("card-a");
    expect(row(2).getAttribute("aria-current")).toBe("true");
    expect(useDocumentStore.getState().dirty).toBe(false);
    await key("Escape", document.activeElement!);
    expect(document.activeElement).toBe(row(2));
    await key("Escape", document.activeElement!, { repeat: true });
    expect(container.querySelector(".fc-history-timeline")).not.toBeNull();
    await key("ArrowUp", document.activeElement!);
    expect(document.activeElement).toBe(row(1));
    await key("Escape", document.activeElement!);
    expect(container.textContent).toBe("Live tree");
  });

  it("publishes the first refreshed page while the next page is still loading", async () => {
    await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(21);
    historyHead = { id: "new-head", createdAtMs: 26_000, sequence: 26 };
    let allowSecondPage!: () => void;
    const secondPage = new Promise<void>((resolve) => { allowSecondPage = resolve; });
    const fallback = mocks.invoke.getMockImplementation()!;
    let prefetching = false;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "list_document_history" && args.before) {
        prefetching = true;
        await secondPage;
      }
      return fallback(command, args);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(prefetching).toBe(true);
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(11);
    await act(async () => allowSecondPage());
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(21);
  });

  it("uses Down to browse into the next page of snapshots", async () => {
    await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    for (let index = 0; index < 20; index++) await key("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(row(20));
    await key("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(row(21));
    expect(row(21).getAttribute("aria-current")).toBe("true");
  });

  it("scrolls the list to follow the keyboard while the History toolbar stays outside it", async () => {
    await open();
    const list = row(1).parentElement!;
    const panel = list.parentElement!;
    const close = panel.querySelector('button[aria-label="Close History"]')!;
    expect(list.contains(close)).toBe(false);
    Object.defineProperty(list, "clientHeight", { value: 100 });
    list.getBoundingClientRect = () => new DOMRect(0, 40, 200, 100);
    row(1).getBoundingClientRect = () => new DOMRect(0, 110, 200, 65);
    const focus = vi.spyOn(row(1), "focus");

    await key("ArrowDown", document.activeElement!);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(list.scrollTop).toBe(35);
    expect(panel.scrollTop).toBe(0);
  });

  it("centers a changed manuscript passage by scrolling only its pane", async () => {
    comparisons["rev-24"] = { status: "compared", changes: [
      { description: "Text added to the manuscript", kind: "manuscript", passage: { from: 1, to: 8 },
        addedRanges: [{ from: 1, to: 8 }, { from: 9, to: 19 }], characters: { added: 17, removed: 0 } },
    ] };
    await open();
    await key("ArrowDown", document.activeElement!);
    expect(row(1).querySelector(".fc-history-card-symbols")).toBeNull();
    expect(row(1).textContent).not.toContain("Text added to the manuscript");
    const pane = container.querySelector<HTMLElement>(".fc-manuscript-pane")!;
    expect(pane.hidden).toBe(false);
    const dom = pane.querySelector<HTMLElement & { editor: Editor }>(".fc-manuscript-editor")!;
    const coordinates = vi.spyOn(dom.editor.view, "coordsAtPos").mockReturnValue({ top: 430, bottom: 450, left: 0, right: 0 });
    Object.defineProperty(pane, "clientHeight", { value: 200 });
    pane.getBoundingClientRect = () => new DOMRect(0, 80, 400, 200);

    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = { altKey: true, metaKey: apple, ctrlKey: !apple };
    await key("ArrowLeft", window, mod);
    await key("ArrowRight", window, mod);

    expect(coordinates).toHaveBeenCalledWith(1);
    expect(pane.scrollTop).toBe(260);
    expect(pane.closest(".fc-history-preview")?.scrollTop).toBe(0);
    expect([...pane.querySelectorAll(".fc-history-text-added")].map((node) => node.textContent))
      .toEqual(["Earlier", "manuscript"]);
  });

  it("switches from a manuscript-only save to Tree for a card-only save", async () => {
    comparisons["rev-24"] = { status: "compared", changes: [
      { description: "Manuscript edited", kind: "manuscript", passage: { from: 1, to: 8 } },
    ] };
    comparisons["rev-23"] = { status: "compared", changes: [
      { description: "Text added to B01", kind: "cardEdited", card: { id: "card-a", label: "B01" },
        cardId: "card-a", addedRanges: [{ from: 1, to: 8 }] },
    ] };
    await open();
    await key("ArrowDown", row(0));
    expect(container.querySelector(".fc-manuscript-pane:not([hidden])")).not.toBeNull();
    expect(container.querySelector(".fc-history-timeline")?.getAttribute("data-pane")).toBe("manuscript");
    await key("ArrowDown", row(1));
    expect(container.querySelector(".fc-manuscript-pane:not([hidden])")).toBeNull();
    expect(container.querySelector(".fc-history-timeline")?.getAttribute("data-pane")).toBe("tree");
    expect(container.querySelector('[data-testid="document-stage"] .fc-history-text-added')?.textContent).toBe("Deleted");
  });

  it("focuses a read-only manuscript on Enter and returns to the selected snapshot on Escape", async () => {
    comparisons["rev-24"] = { status: "compared", changes: [
      { description: "Text added to the manuscript", kind: "manuscript", passage: { from: 1, to: 8 } },
    ] };
    await open();
    await key("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(row(1));
    await key("Enter", document.activeElement!);
    const manuscript = container.querySelector(".fc-manuscript-editor");
    expect(document.activeElement).toBe(manuscript);
    expect(manuscript?.getAttribute("contenteditable")).toBe("false");
    await key("Escape", document.activeElement!);
    expect(document.activeElement).toBe(row(1));
  });

  it("shows saved deltas and opens the spatial tree at the affected card", async () => {
    historical = createChildCard(historical, "card-a", "card-child");
    comparisons["rev-23"] = { status: "compared", changes: [
      { description: "Text added to B01", kind: "cardEdited", card: { id: "card-a", label: "B01" }, cardId: "card-a", addedRanges: [{ from: 1, to: 8 }] },
      { description: "C01 card deleted", kind: "cardDeleted", card: { id: "deleted", label: "C01" }, cardId: "card-b" },
      { description: "Text added to the manuscript", kind: "manuscript", passage: { from: 9, to: 19 } },
    ] };
    useInteractionStore.getState().setActiveCardId("card-b");
    await open();
    expect(row(2).querySelector("time")).not.toBeNull();
    expect(row(2).querySelector('[aria-label="Text added to B01"]')?.textContent?.trim()).toBe("B01");
    expect(row(2).querySelector('[aria-label="C01 card deleted"]')?.textContent?.trim()).toBe("C01");
    await click(row(2));
    const stage = container.querySelector<HTMLElement>('[data-testid="document-stage"]')!;
    const active = () => stage.querySelector('[data-testid="active-card-shell"]')?.getAttribute("data-manuscript-target");
    expect(active()).toBe("card-a");
    expect(stage.textContent).toContain("Deleted branch");
    expect(stage.querySelector(".fc-history-text-added")?.textContent).toBe("Deleted");
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    await key("ArrowRight", stage);
    expect(active()).toBe("card-child");
    await key("a", stage);
    expect(useDocumentStore.getState().dirty).toBe(false);
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await key("ArrowRight", stage, { altKey: true, metaKey: apple, ctrlKey: !apple });
    expect(container.querySelector(".fc-manuscript-pane:not([hidden]) .fc-manuscript-editor")?.getAttribute("contenteditable"))
      .toBe("false");
  });

  it("shows only the representative of a group with a single timestamp", async () => {
    vi.setSystemTime(24_000 + 57 * 60_000 + 10_000);
    entries = archive.slice(0, 3);
    visibleEntries = [entries[1]!];
    previousVisible["rev-23"] = null;
    comparisons["rev-23"] = { status: "compared", changes: [
      { description: "B11 card added", kind: "cardAdded", card: { id: "new", label: "B11" },
        characters: { added: 2, removed: 0 } },
      { description: "A02 card reordered", kind: "cardMoved", card: { id: "card-a", label: "A02" } },
      { description: "A03 card reordered", kind: "cardMoved", card: { id: "card-b", label: "A03" } },
      { description: "Text edited in A02", kind: "cardEdited", card: { id: "card-a", label: "A02" },
        characters: { added: 3, removed: 3 } },
      { description: "C03 card deleted", kind: "cardDeleted", card: { id: "deleted", label: "C03" },
        cardId: "card-a", characters: { added: 0, removed: 6 } },
      { description: "Text added to the manuscript", kind: "manuscript", characters: { added: 1, removed: 0 } },
    ] };
    await open();
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(2);
    expect(row(1).querySelector("time")?.textContent?.trim()).toBe("57 minutes ago");
    expect(row(1).textContent?.match(/57 minutes ago/g)).toHaveLength(1);
    expect(document.activeElement).toBe(row(0));
    expect(row(0).getAttribute("aria-current")).toBe("true");
    expect(container.querySelector("input[type=checkbox]")).toBeNull();
    expect(row(1).textContent).not.toContain("in this group");
    const symbols = [...row(1).querySelectorAll(".fc-history-card-symbol")];
    expect(symbols.map((element) => [element.textContent?.trim(), element.getAttribute("data-change")])).toEqual([
      ["B11", "added"], ["A02", "modified"], ["A03", "modified"], ["C03", "removed"],
    ]);
    expect(symbols[1]?.getAttribute("aria-label")).toBe("A02 card reordered. Text edited in A02");
    expect(row(1).querySelector('.fc-history-character-total [data-change="added"] [aria-hidden]')?.textContent).toBe("+6");
    expect(row(1).querySelector('.fc-history-character-total [data-change="removed"] [aria-hidden]')?.textContent).toBe("−9");
    expect(mocks.invoke.mock.calls.some(([name, args]) => name === "compare_document_history" &&
      args.baselines?.["rev-23"] === null)).toBe(true);

    await click(row(1));
    expect(row(1).textContent).not.toContain("Text added to the manuscript");
    expect(container.querySelector(".fc-history-preview select")).toBeNull();
    expect(container.textContent).not.toContain("Historical Preview");
  });

  it("pastes historical manuscript HTML as independent formatted prose", async () => {
    await open();
    await click(row(2));
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await key("ArrowRight", window, { altKey: true, metaKey: apple, ctrlKey: !apple });
    const historyProse = container.querySelector(".fc-manuscript-editor")!;
    const editor = new Editor({ extensions: proseExtensions(), content: "<p>Current writing.</p>" });
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      expect(editor.view.pasteHTML(historyProse.innerHTML)).toBe(true);
      expect(editor.getText()).toContain("Current writing.");
      expect(editor.getText()).toContain("Earlier manuscript");
      expect(editor.getHTML()).toContain("<strong>Earlier manuscript</strong>");
      expect(editor.getHTML()).not.toContain("fc-manuscript-link-bar");
    } finally {
      editor.destroy();
    }
  });

  it("keeps a loaded preview and its copy action after pruning removes the row", async () => {
    await open();
    await key("ArrowDown", row(0));
    expect(document.activeElement).toBe(row(1));
    await click(row(2));
    entries = entries.filter(({ id }) => id !== "rev-23");
    maintenanceAtMs = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(container.textContent).toContain("You can still copy its content");
    await key("Enter", row(2));
    await key("Enter", document.activeElement!);
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    expect(container.textContent).toContain("Deleted branch");
  });

  it("leaves Current and its dirty edits intact when a flush fails", async () => {
    await open();
    await act(async () => useDocumentStore.getState().updateSnapshot((snapshot) => replaceCardContent(snapshot, {
      cardId: "card-b", contentJson: contentJsonForPlainText("Unsaved work"),
    })));
    mocks.flush.mockRejectedValueOnce({ code: "sqlite_error", message: "Disk is unavailable" });
    await click(row(2));
    expect(container.textContent).toContain("Disk is unavailable");
    expect(row(0).getAttribute("aria-current")).toBe("true");
    expect(useDocumentStore.getState().dirty).toBe(true);
    expect(useDocumentStore.getState().historicalPreview).toBe(false);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "load_historical_snapshot")).toBe(false);
  });

  it("shows an unavailable row and offers Back on a narrow window", async () => {
    await open(true);
    mocks.invoke.mockRejectedValueOnce({ code: "history_revision_unavailable" });
    await click(row(2));
    expect(container.querySelector<HTMLElement>(".fc-history-timeline")?.hidden).toBe(true);
    expect(container.textContent).toContain("This snapshot is unavailable.");
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    await click(button("Back"));
    expect(container.querySelector<HTMLElement>(".fc-history-timeline")?.hidden).toBe(false);
    await click(row(0));
    expect(container.querySelector(".fc-history-preview")).toBeNull();
  });

  it("refreshes a stale confirmation, then installs one committed undoable restore", async () => {
    await act(async () => root.render(<Harness keepLiveMounted />));
    await click(row(2));
    await key("Enter", row(2));
    await key("Enter", document.activeElement!);
    expect(container.querySelector("[role=alertdialog]")).not.toBeNull();
    await key("Escape");
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    expect(container.querySelector(".fc-history-preview")).not.toBeNull();
    await key("Enter", row(2));
    await key("Enter", document.activeElement!);

    const nextHead = { id: "external", createdAtMs: 25_000, sequence: 25 };
    const restoredHead = { id: "restored", createdAtMs: 26_000, sequence: 26 };
    const fallback = mocks.invoke.getMockImplementation()!;
    const restoreRequests: (string | null)[] = [];
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command !== "restore_historical_snapshot") return fallback(command, args);
      restoreRequests.push(args.expectedHead);
      if (args.expectedHead === "live-head") {
        historyHead = nextHead;
        entries = [nextHead, ...entries];
        live = { ...replaceCardContent(live, { cardId: "card-b", contentJson: contentJsonForPlainText("MCP change") }),
          revisions: [nextHead] };
        throw { code: "stale_document_revision", message: "Current changed" };
      }
      return { ...historical, revisions: [restoredHead] };
    });

    await click(button("Restore"));
    expect(restoreRequests).toEqual(["live-head"]);
    expect(container.textContent).toContain("Current changed");
    expect(container.querySelector(".fc-history-preview")?.textContent).toContain("Deleted branch");
    expect(button("Restore").disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await click(button("Restore"));
    expect(restoreRequests).toEqual(["live-head", "external"]);
    expect(container.querySelector(".fc-history-timeline")).toBeNull();
    expect(document.activeElement?.matches(".ProseMirror[contenteditable=true]")).toBe(true);
    expect(latestRevisionId(useDocumentStore.getState().snapshot!)).toBe("restored");
    expect(useDocumentStore.getState().dirty).toBe(false);
    expect(useDocumentStore.getState().snapshot?.manuscript).toEqual(historical.manuscript);

    await act(async () => useDocumentStore.getState().undoEditing());
    expect(useDocumentStore.getState().snapshot?.contents.find(({ cardId }) => cardId === "card-b")?.contentJson).toContain("MCP change");
    expect(latestRevisionId(useDocumentStore.getState().snapshot!)).toBe("restored");
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it("opens the restored manuscript for editing from the live Tree layout", async () => {
    comparisons["rev-23"] = { status: "compared", changes: [
      { description: "Text added to the manuscript", kind: "manuscript", addedRanges: [{ from: 1, to: 8 }] },
    ] };
    const fallback = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command !== "restore_historical_snapshot") return fallback(command, args);
      return { ...historical, revisions: [{ id: "restore", createdAtMs: 25_000, sequence: 25 }, ...entries] };
    });
    await act(async () => root.render(<Harness keepLiveMounted />));
    await click(row(2));
    await key("Enter", row(2));
    expect(document.activeElement?.matches(".fc-history-preview .fc-manuscript-editor[contenteditable=false]")).toBe(true);
    await key("Enter", document.activeElement!);
    await click(button("Restore"));

    expect(container.querySelector(".fc-history-timeline")).toBeNull();
    expect(document.activeElement?.matches(".fc-manuscript-editor[contenteditable=true]")).toBe(true);
    expect(container.querySelector(".fc-history-text-added")).toBeNull();
    expect(useDocumentStore.getState().snapshot?.revisions.map(({ id }) => id)).toEqual(["restore", ...archive.map(({ id }) => id)]);
  });

  it("copies a deleted subtree with references and pastes it into Current as one edit", async () => {
    historical = replaceCardContent(createChildCard(earlier, "card-a", "deleted-child"), {
      cardId: "card-a",
      contentJson: JSON.stringify({
        type: "doc", content: [{ type: "paragraph", content: [
          { type: CARD_LINK_NODE, attrs: { targetCardId: "deleted-child", label: "C01" } },
        ] }],
      }),
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    try {
      await open();
      await click(row(2));
      await act(async () => container.querySelector<HTMLElement>('[data-manuscript-target="card-a"]')!.click());
      await key("Enter", row(2));
      await key("c", document.activeElement!, { ctrlKey: true });
      const payload = decodeCardClipboardPayload(writeText.mock.calls[0]![0])!;
      expect(payload.kind).toBe("subtree");
      await click(row(0));
      const state = useDocumentStore.getState();
      let count = 0;
      await act(async () => state.applyNavigationChange((snapshot) =>
        pasteCardClipboardPayload(snapshot, "card-b", payload, () => `pasted-${++count}`)));
      expect(useDocumentStore.getState().snapshot?.cards.find(({ id }) => id === "pasted-2")?.parentId).toBe("pasted-1");
      expect(useDocumentStore.getState().snapshot?.contents.find(({ cardId }) => cardId === "pasted-1")?.contentJson).toContain("pasted-2");
      expect(useDocumentStore.getState().snapshot?.cards.some(({ id }) => id === "card-b")).toBe(true);
      await act(async () => useDocumentStore.getState().undoNavigation());
      expect(useDocumentStore.getState().snapshot?.cards).toEqual(state.snapshot?.cards);
    } finally {
      writeText.mockRestore();
    }
  });
});
