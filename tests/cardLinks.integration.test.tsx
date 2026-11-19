import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCurrentDocumentSnapshot } from "../src/storage/documentSnapshots";
import { DocumentWorkspace } from "../src/components/DocumentWorkspace";
import { useDocumentStore } from "../src/state/documentStore";
import { useInteractionStore } from "../src/state/interactionStore";
import { useAppStore } from "../src/state/appStore";
import { cardContent, contentJsonForPlainText, replaceCardContent } from "../src/domain/document/content";
import { createChildCard, deleteCardSubtree, moveCardWithinParent } from "../src/domain/document/tree";
import { dispatchNativeMenuAction } from "../src/lib/nativeMenu";
import { appearanceId } from "../src/domain/document/references";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

vi.mock("../src/storage/documentSnapshots", () => ({ loadCurrentDocumentSnapshot: vi.fn() }));
vi.mock("../src/storage/fableDirectory", () => ({
  listCurrentDocumentDirectory: vi.fn(async () => ({
    currentDocumentPath: "/tmp/story.fable", entries: [], folderName: "tmp", folderPath: "/tmp", parentFolderPath: "/",
  })),
}));
vi.mock("../src/storage/useDocumentAutosave", () => ({ useDocumentAutosave: () => {} }));
vi.mock("../src/storage/useExternalDocumentReload", () => ({ useExternalDocumentReload: () => {} }));

const originalWidth = window.innerWidth;
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 }); });
const originalResizeObserver = globalThis.ResizeObserver;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  globalThis.ResizeObserver = originalResizeObserver;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalAct;
  document.body.innerHTML = "";
});

function referenceSnapshot(ownedChildren = true) {
  let snapshot = makeDocumentSnapshot();
  snapshot = createChildCard(snapshot, "card-b", "target-child");
  if (ownedChildren) snapshot = createChildCard(snapshot, "card-a", "owned-child");
  for (const card of snapshot.cards) snapshot = replaceCardContent(snapshot, { cardId: card.id, contentJson: contentJsonForPlainText(`Text for ${card.id}`) });
  return replaceCardContent(snapshot, { cardId: "card-a", contentJson: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "See " },
    { type: "cardLink", attrs: { targetCardId: "card-b", label: "B02" } },
    { type: "cardLink", attrs: { targetCardId: "card-b", label: "B02" } },
  ] }] }) });
}

async function mountReferences(ownedChildren = true) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  useDocumentStore.getState().clearDocument();
  const snapshot = referenceSnapshot(ownedChildren);
  vi.mocked(loadCurrentDocumentSnapshot).mockResolvedValue(snapshot);
  useDocumentStore.getState().hydrateSnapshot(snapshot);
  useInteractionStore.setState({ activeCardId: "card-a", previousCardIds: [], rememberedChildIds: {}, referencePath: null });
  useAppStore.setState({ activeDocument: snapshot.summary, mode: "navigation", screen: "workspace", notice: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
  return { root, container, snapshot };
}

async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })); });
}

describe("inline references in the real workspace and editor", () => {
  it("enters owned children first, explores aliases above, returns through the path and edits at the original", async () => {
    const { root, container } = await mountReferences();
    const ownedBefore = container.querySelector('[data-appearance-id="owned-child"]');
    expect(ownedBefore).not.toBeNull();
    expect(container.querySelectorAll('[data-reference="true"]')).toHaveLength(1);
    await key("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("owned-child");
    await key("ArrowUp");
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    const path = useInteractionStore.getState().referencePath!;
    expect(path[path.length - 1]).toEqual({ cardId: "card-b", alias: true });
    const aliasElement = Array.from(container.querySelectorAll<HTMLElement>("[data-appearance-id]")).find((element) => element.dataset.appearanceId === appearanceId(path));
    expect(aliasElement?.querySelector(".fc-reference-icon")).toBeTruthy();
    await key("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("target-child");
    expect(useInteractionStore.getState().referencePath).toHaveLength(path.length + 1);
    await key("ArrowLeft");
    expect(useInteractionStore.getState().referencePath).toEqual(path);
    await key("ArrowLeft");
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useInteractionStore.getState().referencePath).toBeNull();
    await key("ArrowRight");
    await key("ArrowUp");
    await key("ArrowRight");
    await key("Enter");
    expect(useInteractionStore.getState().activeCardId).toBe("target-child");
    expect(useInteractionStore.getState().referencePath).toBeNull();
    expect(useAppStore.getState().mode).toBe("editing");
    expect(container.querySelector('[data-testid="active-card-shell"] .ProseMirror')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("blocks direct alias deletion, cut and reparenting, and creates children at the original via keyboard and native menu", async () => {
    const { root } = await mountReferences(false);
    await key("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(useInteractionStore.getState().referencePath).not.toBeNull();
    const before = useDocumentStore.getState().snapshot;
    for (const name of ["Delete", "Backspace"]) await key(name);
    for (const name of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) await key(name, { shiftKey: true });
    await act(async () => { dispatchNativeMenuAction("shift-up"); });
    const cut = new Event("cut", { bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(cut); });
    expect(cut.defaultPrevented).toBe(true);
    expect(useDocumentStore.getState().snapshot).toEqual(before);
    expect(useInteractionStore.getState().referencePath).not.toBeNull();
    await key("Tab");
    await key("ArrowRight");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab" })); });
    const created = useInteractionStore.getState().activeCardId!;
    expect(useDocumentStore.getState().snapshot?.cards.find((card) => card.id === created)?.parentId).toBe("card-b");
    expect(useInteractionStore.getState().referencePath).toBeNull();
    expect(useAppStore.getState().mode).toBe("editing");
    // Re-enter the reference and exercise the menu entry point as well.
    await act(async () => {
      useInteractionStore.getState().setActiveCardId("card-a");
      useAppStore.getState().setMode("navigation");
    });
    await key("ArrowRight");
    await act(async () => { dispatchNativeMenuAction("create-child"); });
    expect(useInteractionStore.getState().referencePath).toBeNull();
    expect(useDocumentStore.getState().snapshot?.cards.find((card) => card.id === useInteractionStore.getState().activeCardId)?.parentId).toBe("card-b");
    await act(async () => { root.unmount(); });
  });

  it("keeps a deleted target selectable as ?, restores it with undo, and removes the alias only with its final inline reference", async () => {
    const { root, container } = await mountReferences(false);
    await key("ArrowRight");
    const path = useInteractionStore.getState().referencePath;
    await act(async () => { useDocumentStore.getState().applyNavigationChange((snapshot) => deleteCardSubtree(snapshot, "card-b")); });
    expect(useInteractionStore.getState().referencePath).toEqual(path);
    expect(container.querySelector('[data-reference="true"] .fc-card-identity')?.textContent).toBe("?");
    await key("ArrowRight");
    await key("Enter");
    expect(useAppStore.getState().mode).toBe("navigation");
    await act(async () => { useDocumentStore.getState().undoNavigation(); });
    expect(container.querySelector('[data-reference="true"] .fc-card-identity')?.textContent).toContain("B02");
    await act(async () => { useDocumentStore.getState().updateSnapshot((snapshot) => {
      const document = JSON.parse(cardContent(snapshot, "card-a"));
      document.content[0].content.pop();
      return replaceCardContent(snapshot, { cardId: "card-a", contentJson: JSON.stringify(document) });
    }); });
    expect(useInteractionStore.getState().referencePath).toEqual(path);
    await act(async () => { useDocumentStore.getState().updateSnapshot((snapshot) => replaceCardContent(snapshot, { cardId: "card-a", contentJson: contentJsonForPlainText("See") })); });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useInteractionStore.getState().referencePath).toBeNull();
    expect(container.querySelector('[data-reference="true"]')).toBeNull();
    expect(useDocumentStore.getState().snapshot?.cards.some((card) => card.id === "card-b")).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it("copies a card, pastes a link, follows its new label after reorder, and activates preview links", async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    useDocumentStore.getState().clearDocument();
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root", contentJson: contentJsonForPlainText("See "),
    });
    vi.mocked(loadCurrentDocumentSnapshot).mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.setState({ activeCardId: "card-a", previousCardIds: [], rememberedChildIds: {} });
    useAppStore.setState({ activeDocument: snapshot.summary, mode: "navigation", screen: "workspace", notice: null });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    const clipboard = new Map<string, string>();
    const event = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        getData: (type: string) => clipboard.get(type) ?? "",
        setData: (type: string, text: string) => clipboard.set(type, text), files: [],
      } });
      return event;
    };
    await act(async () => { window.dispatchEvent(event("copy")); });
    await act(async () => {
      useInteractionStore.getState().setActiveCardId("card-root");
      useAppStore.getState().setMode("editing");
    });
    const editor = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      editor.editor.commands.setTextSelection(5);
      editor.dispatchEvent(event("paste"));
    });
    expect(cardContent(useDocumentStore.getState().snapshot!, "card-root")).toContain('"targetCardId":"card-a"');
    expect(useDocumentStore.getState().snapshot?.cards).toHaveLength(3);
    await act(async () => {
      useDocumentStore.getState().applyNavigationChange((snapshot) => moveCardWithinParent(snapshot, "card-a", 1));
    });
    expect(editor.querySelector(".fc-card-link")?.textContent).toBe("B02");
    await act(async () => { (editor.querySelector(".fc-card-link") as HTMLElement).click(); });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");
    // The source is now a parent preview. Activating its chip must not select the parent.
    const previewChip = container.querySelector(".fc-preview .fc-card-link") as HTMLElement;
    expect(previewChip.textContent).toBe("B02");
    await act(async () => { previewChip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");
    await act(async () => { root.unmount(); });
  });
});
