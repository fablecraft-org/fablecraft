import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "../src/components/DocumentWorkspace";
import { CARD_CLIPBOARD_MIME_TYPE, createCardCopyPayload } from "../src/domain/document/clipboard";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { manuscriptUuid } from "../src/domain/document/manuscript";
import { MANUSCRIPT_CUT_MIME } from "../src/domain/document/manuscriptClipboard";
import { splitMinimumWidth } from "../src/domain/document/manuscriptLayout";
import { parseManuscriptMarkdown } from "../src/domain/document/manuscriptMarkdown";
import type { DocumentSnapshot, Manuscript } from "../src/domain/document/types";
import { dispatchNativeMenuAction, type NativeMenuAction } from "../src/lib/nativeMenu";
import { useAppStore } from "../src/state/appStore";
import { useDocumentStore } from "../src/state/documentStore";
import { useInteractionStore } from "../src/state/interactionStore";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), confirm: vi.fn(), open: vi.fn(), save: vi.fn(), read: vi.fn(), write: vi.fn(),
}));
vi.mock("../src/storage/documentSnapshots", () => ({ loadCurrentDocumentSnapshot: mocks.load }));
vi.mock("../src/storage/fableDirectory", () => ({
  listCurrentDocumentDirectory: async () => null,
  listFableDirectory: async () => null,
}));
vi.mock("../src/storage/useDocumentAutosave", () => ({ useDocumentAutosave: () => {} }));
vi.mock("../src/storage/useExternalDocumentReload", () => ({ useExternalDocumentReload: () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm, open: mocks.open, save: mocks.save }));
vi.mock("../src/storage/textFiles", () => ({ readTextFileAtPath: mocks.read, writeTextFileAtPath: mocks.write }));

let container: HTMLDivElement;
let root: Root;
let source: DocumentSnapshot;

const current = () => useDocumentStore.getState().snapshot?.manuscript ?? null;
const pane = () => container.querySelector<HTMLElement>(".fc-manuscript-pane")!;
const tree = () => container.querySelector<HTMLElement>(".fc-tree-pane")!;
const editor = () => container.querySelector<HTMLElement & { editor: Editor }>(".fc-manuscript-editor")!.editor;
const editorElement = () => editor().view.dom;
const split = () => container.querySelector("[role=separator]");
const name = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
  .find((button) => button.textContent === label || button.getAttribute("aria-label") === label)!;

function resize(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function key(target: EventTarget, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

function chord(direction: "Left" | "Right", extra: KeyboardEventInit = {}) {
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  return key(document.activeElement ?? window, `Arrow${direction}`,
    { altKey: true, ...(apple ? { metaKey: true } : { ctrlKey: true }), ...extra });
}

async function action(command: NativeMenuAction) {
  await act(async () => dispatchNativeMenuAction(command));
}

function clip(target: HTMLElement, type: "paste" | "cut" | "copy", data: DataTransfer) {
  const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
  target.dispatchEvent(event);
  return event;
}

function prose(source: string): Manuscript {
  return { id: manuscriptUuid(), contentJson: parseManuscriptMarkdown(source).contentJson, passages: [] };
}

async function mount(snapshot: DocumentSnapshot = source) {
  mocks.load.mockResolvedValue(snapshot);
  useAppStore.getState().setDocument(snapshot.summary);
  await act(async () => root.render(<DocumentWorkspace document={snapshot.summary} />));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDocumentStore.getState().clearDocument();
  useAppStore.setState({ mode: "navigation", notice: null });
  useInteractionStore.getState().setActiveCardId(null);
  for (const mock of Object.values(mocks)) mock.mockReset();
  source = makeDocumentSnapshot();
  resize(splitMinimumWidth + 220);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Manuscript workspace", () => {
  it("visits each layout without creating prose, routes chords and preserves editor selection on resize", async () => {
    await mount();
    expect(pane().hidden).toBe(true);
    await act(async () => { chord("Right"); });
    expect(split()).not.toBeNull();
    expect(document.activeElement).toBe(editorElement());
    expect(current()).toBeNull();
    await act(async () => { chord("Right", { repeat: true }); });
    expect(split()).not.toBeNull();
    await act(async () => { chord("Right"); });
    expect(tree().style.display).toBe("none");
    expect(current()).toBeNull();

    expect(pane().querySelector("button")).toBeNull();
    expect(document.activeElement).toBe(editorElement());
    await act(async () => editor().commands.insertContent("First sentence."));
    expect(current()?.contentJson).toContain("First sentence.");
    expect(pane().textContent).not.toContain("Linked passages");
    await act(async () => { editor().commands.setTextSelection({ from: 2, to: 8 }); chord("Left"); });
    expect(split()).not.toBeNull();
    expect(useInteractionStore.getState().workspacePane).toBe("tree");
    await act(async () => resize(splitMinimumWidth - 1));
    expect(pane().hidden).toBe(true);
    expect(split()).toBeNull();
    await act(async () => resize(splitMinimumWidth));
    expect(split()).not.toBeNull();
    await act(async () => { chord("Right"); });
    expect(document.activeElement).toBe(editorElement());
    const selection = editor().state.selection.toJSON();
    await act(async () => resize(408));
    expect(tree().style.display).toBe("none");
    expect(split()).toBeNull();
    expect(editor().state.selection.toJSON()).toEqual(selection);
    await action("layout-both");
    expect(useAppStore.getState().notice?.message).toContain("Widen the window");
    await act(async () => resize(splitMinimumWidth + 1));
    expect(split()).not.toBeNull();
    expect(editor().state.selection.toJSON()).toEqual(selection);
    expect(chord("Right", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(chord("Right", { isComposing: true }).defaultPrevented).toBe(false);
    await action("layout-tree");
    expect(pane().hidden).toBe(true);
    await act(async () => resize(408));
    await act(async () => resize(splitMinimumWidth + 240));
    expect(split()).toBeNull();
  });

  it("restores the existing split and active pane when the temporary History view closes", async () => {
    source.manuscript = prose("A saved manuscript.");
    await mount();
    await action("layout-both");
    await act(async () => editorElement().focus());
    expect(split()).not.toBeNull();
    const key = `fablecraft.workspace.${source.summary.documentId}`;
    const saved = localStorage.getItem(key);

    await act(async () => root.render(
      <DocumentWorkspace document={source.summary} historyOpen historyPane="tree" />,
    ));
    expect(split()).toBeNull();
    expect(pane().hidden).toBe(true);
    expect(localStorage.getItem(key)).toBe(saved);
    await act(async () => root.render(
      <DocumentWorkspace document={source.summary} historyPaneRequest={{ pane: "manuscript" }} />,
    ));
    expect(split()).not.toBeNull();
    expect(document.activeElement).toBe(editorElement());
    expect(localStorage.getItem(key)).toBe(saved);
  });

  it("saves the first typed change as one undoable creation and opens a blank editor at 408 px", async () => {
    resize(408);
    await mount();
    await act(async () => { chord("Right"); });
    expect(split()).toBeNull();
    expect(document.activeElement).toBe(editorElement());
    expect(current()).toBeNull();
    expect(pane().querySelector("button")).toBeNull();

    await act(async () => editor().commands.insertContent("An opening."));
    const firstDraft = current();
    expect(firstDraft?.contentJson).toContain("An opening.");
    await action("undo");
    expect(current()).toBeNull();
    await action("redo");
    expect(current()).toEqual(firstDraft);
  });

  it.each(["navigation", "editing"] as const)(
    "restores the %s card's appearance and position after a focus round trip in Both",
    async (mode) => {
      source.manuscript = prose("The manuscript.");
      source.contents[0]!.contentJson = parseManuscriptMarkdown("The current tree card.").contentJson;
      await mount();
      await action("layout-both");
      await act(async () => useAppStore.getState().setMode(mode));

      const shell = () => tree().querySelector<HTMLElement>('[data-testid="active-card-shell"]')!;
      const card = shell();
      const cardEditorElement = card.querySelector<HTMLElement & { editor: Editor }>(".ProseMirror")!;
      const cardEditor = cardEditorElement.editor;
      if (mode === "editing") {
        await act(async () => cardEditor.commands.setTextSelection({ from: 2, to: 7 }));
      }
      const selection = cardEditor.state.selection.toJSON();
      const geometry = () => [card.style.left, card.style.top, card.style.transform,
        card.style.paddingTop, card.style.paddingBottom, card.style.zIndex];
      const position = geometry();
      const previousStyle = card.style.backgroundColor;
      const snapshot = useDocumentStore.getState().snapshot;

      await act(async () => { chord("Right"); });
      expect(useInteractionStore.getState().workspacePane).toBe("manuscript");
      expect(card.style.backgroundColor).toBe("var(--fc-color-card-surface)");
      expect(card.style.boxShadow).toBe("none");
      expect(shell()).toBe(card);
      expect(geometry()).toEqual(position);
      expect(cardEditor.state.selection.toJSON()).toEqual(selection);

      await act(async () => { chord("Left"); });
      expect(useInteractionStore.getState().activeCardId).toBe("card-root");
      expect(useInteractionStore.getState().workspacePane).toBe("tree");
      expect(card.style.backgroundColor).toBe(previousStyle);
      expect(card.style.boxShadow).toBe("var(--fc-shadow-elevated)");
      expect(shell()).toBe(card);
      expect(geometry()).toEqual(position);
      expect(cardEditor.state.selection.toJSON()).toEqual(selection);
      expect(useDocumentStore.getState().snapshot).toBe(snapshot);
    },
  );

  it("resizes the split without starting text selection or shifting focus from the editor", async () => {
    source.manuscript = prose("Keep this selection while resizing.");
    await mount();
    await action("layout-manuscript");
    await action("layout-both");
    await act(async () => editor().commands.setTextSelection({ from: 1, to: 10 }));
    const selection = editor().state.selection.toJSON();
    const snapshot = useDocumentStore.getState().snapshot;
    const divider = split() as HTMLElement;
    const capture = vi.fn();
    Object.defineProperties(divider, {
      setPointerCapture: { value: capture },
      hasPointerCapture: { value: (pointerId: number) => capture.mock.calls.some(([captured]) => captured === pointerId) },
    });
    const down = new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 5, isPrimary: true, button: 0,
    });
    const move = new PointerEvent("pointermove", {
      bubbles: true, pointerId: 5, clientX: 520,
    });

    await act(async () => {
      divider.dispatchEvent(down);
      divider.dispatchEvent(move);
    });

    expect(down.defaultPrevented).toBe(true);
    expect(capture).toHaveBeenCalledWith(5);
    expect(tree().style.width).toBe("520px");
    expect(document.activeElement).toBe(editorElement());
    expect(editor().state.selection.toJSON()).toEqual(selection);
    expect(useInteractionStore.getState().workspacePane).toBe("manuscript");
    expect(useDocumentStore.getState().snapshot).toBe(snapshot);

    await act(async () => {
      divider.focus();
      expect(key(divider, "ArrowLeft").defaultPrevented).toBe(true);
    });
    expect(parseFloat(tree().style.width)).toBeLessThan(520);
    expect(editor().state.selection.toJSON()).toEqual(selection);
  });

  it("pastes a navigation-mode draft into an absent manuscript and replaces a selection in one undo", async () => {
    const contentJson = parseManuscriptMarkdown("# Opening\n\nSome **rich** prose.").contentJson;
    source.contents[0] = { cardId: "card-root", contentJson };
    await mount();
    await action("layout-manuscript");
    const data = new DataTransfer();
    data.setData(CARD_CLIPBOARD_MIME_TYPE, JSON.stringify(createCardCopyPayload(source, "card-root")));
    await act(async () => { clip(editorElement(), "paste", data); });
    expect(current()?.contentJson).toBe(contentJson);
    expect(editor().state.doc.textContent).toBe("OpeningSome rich prose.");
    expect(document.activeElement).toBe(editorElement());
    expect(useDocumentStore.getState().snapshot?.contents.find(({ cardId }) => cardId === "card-root")?.contentJson)
      .toBe(contentJson);
    await action("undo");
    expect(current()).toBeNull();
    await action("redo");
    expect(current()?.contentJson).toBe(contentJson);
    await action("layout-manuscript");
    await act(async () => editor().commands.setTextSelection({ from: 1, to: 8 }));
    await act(async () => { clip(editorElement(), "paste", data); });
    const pasted = current()?.contentJson;
    expect(pasted).not.toBe(contentJson);
    await action("undo");
    expect(current()?.contentJson).toBe(contentJson);
    await action("redo");
    expect(current()?.contentJson).toBe(pasted);
  });

  it("links typed card IDs to the full paragraph and stops at the next paragraph", async () => {
    source.manuscript = prose("Original paragraph.");
    await mount();
    await action("layout-manuscript");
    await act(async () => {
      editor().commands.setTextSelection(editor().state.doc.content.size - 1);
      editor().commands.insertContent(" #B02");
    });
    const linked = current()!.passages[0]!;
    expect(linked.targetCardIds).toEqual(["card-b"]);
    expect(editor().state.doc.textBetween(linked.from, linked.to)).toBe("Original paragraph. ");
    expect(current()?.contentJson).not.toContain("#B02");

    await act(async () => editor().commands.insertContent("and some more text"));
    const extended = current()!.passages[0]!;
    expect(extended.id).toBe(linked.id);
    expect(editor().state.doc.textBetween(extended.from, extended.to))
      .toBe("Original paragraph. and some more text");
    await act(async () => editor().commands.splitBlock());
    await act(async () => editor().commands.insertContent("Unlinked at first."));
    expect(current()?.passages).toEqual([extended]);
    await act(async () => {
      const start = editor().state.selection.$from.start();
      editor().commands.setTextSelection(start);
      editor().commands.insertContent(" ");
      editor().commands.setTextSelection(start);
      for (const character of "#B01") editor().commands.insertContent(character);
    });
    expect(current()?.passages.map(({ targetCardIds }) => targetCardIds)).toEqual([["card-b"], ["card-a"]]);
    const second = current()!.passages[1]!;
    expect(editor().state.doc.textBetween(second.from, second.to)).toBe(" Unlinked at first.");
    await action("undo");
    expect(current()?.passages).toEqual([extended]);
    await action("redo");
    expect(current()?.passages).toHaveLength(2);
  });

  it("consumes a tag on a blank line and highlights its target before the first prose is typed", async () => {
    await mount();
    await action("layout-both");
    await act(async () => { chord("Right"); });
    const view = editor().view;
    const coordinates = vi.spyOn(view, "coordsAtPos").mockReturnValue({ top: 24, bottom: 44, left: 0, right: 0 });
    await act(async () => { for (const digit of "#B02") editor().commands.insertContent(digit); });
    expect(editor().state.doc.textContent).toBe("");
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(document.activeElement).toBe(editorElement());
    expect(tree().querySelector<HTMLElement>('[data-testid="active-card-shell"]')?.style.boxShadow)
      .toBe("var(--fc-shadow-elevated)");
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(pane().querySelector<HTMLElement>(".fc-manuscript-link-bar")?.style.height).toBe("20px");

    await act(async () => editor().commands.insertContent("Only this prose is saved."));
    expect(current()?.contentJson).not.toContain("#B02");
    expect(current()?.passages).toHaveLength(1);
    const passage = current()!.passages[0]!;
    expect(passage.targetCardIds).toEqual(["card-b"]);
    expect(editor().state.doc.textBetween(passage.from, passage.to)).toBe("Only this prose is saved.");
    expect(pane().querySelector("button")).toBeNull();
    await act(async () => { chord("Left"); });
    await act(async () => name("Remove manuscript link L1 Only this prose is saved.").click());
    await act(async () => { chord("Right"); });
    expect(current()?.passages).toEqual([]);
    expect(tree().querySelector<HTMLElement>('[data-testid="active-card-shell"]')?.style.boxShadow)
      .toBe("none");
    coordinates.mockRestore();
  });

  it("keeps identifiers literal when they continue into a word, are pasted, or appear in code", async () => {
    await mount();
    await action("layout-manuscript");
    await act(async () => editor().commands.insertContent("#B02suffix"));
    expect(current()?.passages).toEqual([]);
    expect(editor().state.doc.textContent).toBe("#B02suffix");

    await act(async () => editor().commands.splitBlock());
    const data = new DataTransfer();
    data.setData("text/plain", "#B01");
    await act(async () => { clip(editorElement(), "paste", data); });
    expect(current()?.passages).toEqual([]);

    await act(async () => {
      editor().commands.splitBlock();
      editor().commands.setCode();
      editor().commands.insertContent("#B02");
    });
    expect(current()?.passages).toEqual([]);
  });

  it("links through Tree navigation and returns to an unhighlighted passage", async () => {
    source.manuscript = prose("Alpha beta gamma.");
    await mount();
    await action("layout-manuscript");
    await act(async () => editor().commands.selectAll());
    const selection = editor().state.selection.toJSON();
    const treeKey = (value: string, modifiers: KeyboardEventInit = {}) =>
      key(document.activeElement!, value, modifiers);

    await act(async () => { key(editorElement(), "l", { ctrlKey: true }); });
    expect(pane().hidden).toBe(true);
    expect(tree().style.display).not.toBe("none");
    expect(editor().state.selection.empty).toBe(true);
    expect(container.querySelector(".fc-link-target-hint")).not.toBeNull();
    expect(useInteractionStore.getState().workspacePane).toBe("tree");
    await act(async () => { treeKey("Escape"); });
    expect(document.activeElement).toBe(editorElement());
    expect(editor().state.selection.toJSON()).toEqual(selection);
    expect(current()?.passages).toEqual([]);

    await action("link-manuscript-passage");
    await act(async () => { treeKey("Enter"); });
    expect(split()).toBeNull();
    expect(tree().style.display).toBe("none");
    expect(document.activeElement).toBe(editorElement());
    expect(editor().state.selection.empty).toBe(true);
    const first = current()!.passages[0]!;

    await action("layout-both");
    await act(async () => {
      editor().commands.selectAll();
      key(editorElement(), "l", { ctrlKey: true });
    });
    expect(split()).not.toBeNull();
    expect(pane().hidden).toBe(false);
    expect(editor().state.selection.empty).toBe(true);
    expect(pane().querySelector(".fc-manuscript-search-highlight")).toBeNull();
    const cardsBefore = useDocumentStore.getState().snapshot?.cards;
    await act(async () => { treeKey("Delete"); treeKey("ArrowDown", { shiftKey: true }); });
    expect(useDocumentStore.getState().snapshot?.cards).toBe(cardsBefore);
    await act(async () => { treeKey("ArrowRight"); });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    await act(async () => { treeKey("ArrowDown"); });
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(current()?.passages).toEqual([first]);
    await act(async () => { treeKey("Enter"); });
    expect(split()).not.toBeNull();
    expect(document.activeElement).toBe(editorElement());
    expect(editor().state.selection.empty).toBe(true);
    expect(editor().state.selection.from).toBe(first.from);
    expect(current()?.passages).toEqual([{ ...first, targetCardIds: ["card-b"] }]);

    await act(async () => editor().commands.selectAll());
    await action("link-manuscript-passage");
    const beforeDuplicate = current();
    await act(async () => { treeKey("Enter"); });
    expect(current()).toBe(beforeDuplicate);
    await action("layout-tree");
    await act(async () => name("Reveal manuscript passage L1 Alpha beta gamma.").click());
    expect(useInteractionStore.getState().workspacePane).toBe("manuscript");
    expect(editor().state.selection.from).toBe(first.from);
    expect(editor().state.selection.empty).toBe(true);
    expect(pane().querySelector(".fc-manuscript-search-highlight")).toBeNull();
    expect(pane().textContent).not.toContain("Linked passages");
    await act(async () => { chord("Left"); });
    expect(useInteractionStore.getState().workspacePane).toBe("tree");
    mocks.confirm.mockResolvedValue(true);
    await action("remove-manuscript");
    expect(current()).toBeNull();
    expect(pane().hidden).toBe(true);
    await action("undo");
    expect(current()?.passages[0]?.id).toBe(first.id);
    expect(current()?.passages[0]?.targetCardIds).toEqual(["card-b"]);
  });

  it("activates the linked tree card when its text is selected without taking editor focus", async () => {
    source.manuscript = prose("Alpha beta gamma.");
    const first = { id: manuscriptUuid(), from: 1, to: 6, targetCardIds: ["card-a"] };
    const second = { id: manuscriptUuid(), from: 7, to: 11, targetCardIds: ["card-b"] };
    source.manuscript.passages = [first, second];
    await mount();
    await action("layout-both");
    await act(async () => { chord("Right"); });
    await act(async () => editor().commands.setTextSelection({ from: 7, to: 8 }));
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(document.activeElement).toBe(editorElement());
    const activeShell = () => tree().querySelector<HTMLElement>('[data-testid="active-card-shell"]');
    expect(activeShell()?.style.boxShadow).toBe("var(--fc-shadow-elevated)");

    await act(async () => editor().commands.setTextSelection({ from: 1, to: 2 }));
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(document.activeElement).toBe(editorElement());
    await act(async () => editor().commands.setTextSelection({ from: 12, to: 13 }));
    expect(activeShell()?.style.boxShadow).toBe("none");
  });

  it("draws one margin bar across linked lines and removes it when the link is undone", async () => {
    source.manuscript = prose("Alpha beta gamma.\n\nSecond line.");
    await mount();
    await action("layout-manuscript");
    const view = editor().view;
    const coordinates = vi.spyOn(view, "coordsAtPos").mockImplementation((_pos, side) =>
      side === 1 ? { top: 20, bottom: 35, left: 0, right: 0 }
        : { top: 54, bottom: 69, left: 0, right: 0 });
    await act(async () => editor().commands.selectAll());
    await action("link-manuscript-passage");
    await act(async () => { key(document.activeElement!, "Enter"); });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const bar = pane().querySelector<HTMLElement>(".fc-manuscript-link-bar");
    expect(bar?.style.top).toBe("20px");
    expect(bar?.style.height).toBe("49px");
    expect(coordinates).toHaveBeenCalledWith(current()?.passages[0]?.to, -1);
    await action("undo");
    expect(pane().querySelector(".fc-manuscript-link-bar")).toBeNull();
    coordinates.mockRestore();
  });

  it("moves cut associations once, validates undo and redo, and leaves a second paste independent", async () => {
    source.manuscript = prose("Alpha Beta Gamma\n\nDestination");
    const whole = { id: manuscriptUuid(), from: 7, to: 11, targetCardIds: ["card-a"] };
    const partial = { id: manuscriptUuid(), from: 11, to: 17, targetCardIds: ["card-b"] };
    source.manuscript.passages = [whole, partial];
    await mount();
    await action("layout-manuscript");
    const data = new DataTransfer();
    await act(async () => {
      editor().commands.setTextSelection({ from: 7, to: 13 });
      clip(editorElement(), "cut", data);
    });
    expect(data.getData(MANUSCRIPT_CUT_MIME)).toBeTruthy();
    expect(current()?.passages.map(({ id }) => id)).toEqual([partial.id]);
    const afterCut = current();
    await act(async () => {
      editor().commands.setTextSelection(editor().state.doc.content.size - 1);
      clip(editorElement(), "paste", data);
    });
    expect(editor().state.doc.textContent).toBe("Alpha ammaDestinationBeta G");
    expect(current()?.passages).toHaveLength(3);
    expect(current()?.passages.find(({ id }) => id === whole.id)?.from).toBeGreaterThan(20);
    const afterPaste = current();
    await action("undo");
    expect(current()).toEqual(afterCut);
    await action("redo");
    expect(current()).toEqual(afterPaste);
    await action("undo");
    await action("undo");
    expect(current()?.passages).toEqual([whole, partial]);
    await act(async () => {
      editor().commands.setTextSelection(editor().state.doc.content.size - 1);
      clip(editorElement(), "paste", data);
    });
    expect(current()?.passages).toEqual([whole, partial]);
  });

  it("invalidates an undone cut and keeps its clipboard prose available across documents", async () => {
    source.manuscript = prose("Alpha Beta Gamma");
    const linked = { id: manuscriptUuid(), from: 7, to: 11, targetCardIds: ["card-b"] };
    source.manuscript.passages = [linked];
    await mount();
    await action("layout-manuscript");
    const data = new DataTransfer();
    await act(async () => {
      editor().commands.setTextSelection({ from: 7, to: 11 });
      clip(editorElement(), "cut", data);
    });
    expect(current()?.passages).toHaveLength(0);
    await action("undo");
    expect(current()?.passages).toEqual([linked]);
    await action("redo");
    await act(async () => {
      editor().commands.setTextSelection(editor().state.doc.content.size - 1);
      clip(editorElement(), "paste", data);
    });
    expect(current()?.passages).toHaveLength(0);
    expect(editor().state.doc.textContent).toBe("Alpha  GammaBeta");

    const second = makeDocumentSnapshot();
    second.summary = { ...second.summary, documentId: "doc-2", path: "/tmp/second.fable" };
    second.cards = second.cards.map((card) => ({ ...card, documentId: "doc-2" }));
    await mount(second);
    await action("layout-manuscript");
    await act(async () => { clip(editorElement(), "paste", data); });
    expect(editor().state.doc.textContent).toBe("Beta");
    expect(current()?.passages).toEqual([]);
  });

  it("removes an exact backlink from the card footer and restores it on undo", async () => {
    source.manuscript = prose("One. Two. Three. Four.");
    source.manuscript.passages = [
      { from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 17 }, { from: 18, to: 23 },
    ].map((range) => ({ ...range, id: manuscriptUuid(), targetCardIds: ["card-root"] }));
    await mount();

    const first = name("Remove manuscript link L1 One.");
    expect(first.previousElementSibling?.getAttribute("aria-label")).toBe("Reveal manuscript passage L1 One.");
    await act(async () => first.click());
    expect(current()?.contentJson).toBe(source.manuscript.contentJson);
    expect(current()?.passages).toEqual(source.manuscript.passages.slice(1));
    expect(useAppStore.getState().mode).toBe("navigation");
    expect(pane().hidden).toBe(true);

    await action("undo");
    expect(current()?.passages).toEqual(source.manuscript.passages);
    await act(async () => name("1 more manuscript passages").click());
    await act(async () => name("Remove manuscript link L1 Four.").click());
    expect(current()?.passages).toEqual(source.manuscript.passages.slice(0, 3));
    expect(pane().hidden).toBe(true);
  });

  it("prunes deleted card targets, keeps overflow passages reachable and undoes across panes", async () => {
    source.manuscript = prose("One. Two. Three. Four. Five.");
    source.manuscript.passages = [
      { from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 17 }, { from: 18, to: 23 },
    ].map((range) => ({ ...range, id: manuscriptUuid(), targetCardIds: ["card-root"] }));
    source.manuscript.passages.push({ from: 24, to: 29, id: manuscriptUuid(), targetCardIds: ["card-b"] });
    await mount();
    const overflow = container.querySelector(".fc-manuscript-backlinks .fc-manuscript-overflow");
    expect(overflow?.textContent?.trim()).toBe("1 more");
    await act(async () => { (overflow as HTMLElement).click(); });
    await act(async () => name("Reveal manuscript passage L1 Four.").click());
    expect(editor().state.selection.from).toBe(18);
    expect(editor().state.selection.empty).toBe(true);
    await act(async () => {
      useDocumentStore.getState().applyNavigationChange((snapshot) => ({
        ...snapshot, cards: snapshot.cards.filter(({ id }) => id !== "card-b"),
        contents: snapshot.contents.filter(({ cardId }) => cardId !== "card-b"),
      }));
    });
    expect(current()?.passages.map(({ targetCardIds }) => targetCardIds)).toEqual(
      Array.from({ length: 4 }, () => ["card-root"]),
    );
    await action("undo");
    expect(current()?.passages).toEqual(source.manuscript.passages);
    expect(useDocumentStore.getState().snapshot?.cards.some(({ id }) => id === "card-b")).toBe(true);
  });

  it("keeps existing prose on cancelled and invalid imports, and exports pending rich text", async () => {
    source.manuscript = prose("Existing");
    await mount();
    mocks.open.mockResolvedValue("/tmp/prose.md");
    mocks.read.mockResolvedValue("New **draft**");
    mocks.confirm.mockResolvedValue(false);
    const original = current();
    await action("import-manuscript-markdown");
    expect(current()).toEqual(original);
    mocks.read.mockResolvedValue("Bad\0data");
    await action("import-manuscript-markdown");
    expect(current()).toEqual(original);
    expect(useAppStore.getState().notice?.tone).toBe("error");
    mocks.read.mockResolvedValue("# New **draft**");
    mocks.confirm.mockResolvedValue(true);
    await action("import-manuscript-markdown");
    expect(current()?.id).not.toBe(original?.id);
    await act(async () => { editor().commands.setTextSelection(editor().state.doc.content.size - 1); editor().commands.insertContent(" updated"); });
    mocks.save.mockResolvedValue("/tmp/export.md");
    mocks.write.mockRejectedValueOnce(new Error("Disk denied"));
    await action("export-manuscript-markdown");
    expect(useAppStore.getState().notice?.message).toBe("Disk denied");
    await action("export-manuscript-markdown");
    expect(mocks.write).toHaveBeenLastCalledWith("/tmp/export.md", expect.stringContaining("updated"));
  });
});
