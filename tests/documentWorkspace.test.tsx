import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "../src/components/DocumentWorkspace";
import {
  CARD_CLIPBOARD_MIME_TYPE,
  decodeCardClipboardPayload,
  encodeCardClipboardPayload,
} from "../src/domain/document/clipboard";
import {
  contentJsonForPlainText,
  contentText,
  isContentEffectivelyEmpty,
  replaceCardContent,
} from "../src/domain/document/content";
import { NEW_CARD_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { dispatchNativeMenuAction } from "../src/lib/nativeMenu";
import { useAppStore } from "../src/state/appStore";
import { useDocumentStore } from "../src/state/documentStore";
import { useInteractionStore } from "../src/state/interactionStore";
import { useSettingsStore } from "../src/state/settingsStore";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const loadCurrentDocumentSnapshot = vi.fn();
const listCurrentDocumentDirectory = vi.fn();
const listFableDirectory = vi.fn();
const createUntitledDocumentInDirectory = vi.fn();
const deleteFableDocument = vi.fn();
const renameFableDocument = vi.fn();

vi.mock("../src/storage/documentSnapshots", () => ({
  loadCurrentDocumentSnapshot: () => loadCurrentDocumentSnapshot(),
}));

vi.mock("../src/storage/fableDirectory", () => ({
  createUntitledDocumentInDirectory: (...args: unknown[]) => createUntitledDocumentInDirectory(...args),
  deleteFableDocument: (...args: unknown[]) => deleteFableDocument(...args),
  listCurrentDocumentDirectory: () => listCurrentDocumentDirectory(),
  listFableDirectory: (...args: unknown[]) => listFableDirectory(...args),
  renameFableDocument: (...args: unknown[]) => renameFableDocument(...args),
}));

vi.mock("../src/storage/useDocumentAutosave", () => ({
  useDocumentAutosave: () => {},
}));

vi.mock("../src/storage/useExternalDocumentReload", () => ({
  useExternalDocumentReload: () => {},
}));

vi.mock("../src/components/CardEditor", () => ({
  CardEditor: ({
    focusPlacement,
    isEditing,
    onCreateSiblingBelow,
    onCreateBelow,
    onDeleteEmpty,
    onNavigateAbove,
    onNavigateChild,
    placeholder,
    pendingTextInput,
  }: {
    focusPlacement?: string | null;
    isEditing: boolean;
    onCreateSiblingBelow?: () => void;
    onCreateBelow?: (splitContent: { before: string; after: string }) => void;
    onDeleteEmpty?: () => void;
    onNavigateAbove?: (placement?: "start" | "end") => boolean;
    onNavigateChild?: (placement?: "start" | "end") => boolean;
    placeholder?: string;
    pendingTextInput?: string | null;
  }) => (
    <div>
      <div
        data-editing={String(isEditing)}
        data-focus-placement={focusPlacement ?? ""}
        data-placeholder={placeholder ?? ""}
        data-pending-text-input={pendingTextInput ?? ""}
        data-testid="card-editor"
      />
      <button data-testid="card-editor-create-sibling-below" onClick={() => onCreateSiblingBelow?.()} type="button" />
      <button data-testid="card-editor-divide" onClick={() => onCreateBelow?.({
        before: contentJsonForPlainText("Above"),
        after: contentJsonForPlainText("Below"),
      })} type="button" />
      <button data-testid="card-editor-delete-empty" onClick={() => onDeleteEmpty?.()} type="button" />
      <button data-testid="card-editor-navigate-above" onClick={() => onNavigateAbove?.()} type="button" />
      <button data-testid="card-editor-navigate-child-end" onClick={() => onNavigateChild?.("end")} type="button" />
    </div>
  ),
}));

vi.mock("../src/components/TreeCardButton", () => ({
  TreeCardButton: ({
    cardLabel,
    contentJson,
    isActive,
    onClick,
    descendantCount,
    placeholder,
    scale,
    titleOnly,
    x,
    y,
  }: {
    cardLabel?: string;
    contentJson?: string;
    isActive?: boolean;
    onClick?: () => void;
    descendantCount?: number;
    placeholder?: string;
    scale?: number;
    titleOnly?: boolean;
    x?: number;
    y?: number;
  }) => (
    <div
      data-card-label={cardLabel ?? ""}
      data-content-json={contentJson ?? ""}
      data-is-active={String(Boolean(isActive))}
      data-descendant-count={descendantCount ?? 0}
      data-placeholder={placeholder ?? ""}
      data-scale={String(scale ?? "")}
      data-title-only={String(Boolean(titleOnly))}
      data-x={String(x ?? "")}
      data-y={String(y ?? "")}
      data-testid="tree-card"
      onClick={onClick}
    />
  ),
}));

class ResizeObserverMock {
  disconnect() {}

  observe() {}

  takeRecords() {
    return [];
  }

  unobserve() {}
}

function createClipboardEvent(
  type: "copy" | "cut" | "paste",
  seed: Record<string, string> = {},
) {
  const data = new Map(Object.entries(seed));
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  const clipboardData = {
    getData: (format: string) => data.get(format) ?? "",
    setData: (format: string, value: string) => {
      data.set(format, value);
    },
  };

  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: clipboardData,
  });

  return {
    data,
    event,
  };
}

function resetStores() {
  useAppStore.setState({
    activeDocument: null,
    mode: "navigation",
    notice: null,
    screen: "workspace",
  });
  useDocumentStore.setState({
    dirty: false,
    editingFuture: [],
    editingPast: [],
    errorMessage: null,
    lastSavedAtMs: null,
    navigationFuture: [],
    navigationPast: [],
    saveState: "idle",
    snapshot: null,
  });
  useInteractionStore.setState({
    activeCardId: null,
    rememberedChildIds: {},
  });
  useSettingsStore.getState().resetPreferences();
}

function mockLayoutHeight(heightForElement: (element: HTMLElement) => number) {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return heightForElement(this as HTMLElement);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return heightForElement(this as HTMLElement);
    },
  });
}

describe("DocumentWorkspace", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const originalInnerHeight = window.innerHeight;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    loadCurrentDocumentSnapshot.mockReset();
    listCurrentDocumentDirectory.mockReset();
    listFableDirectory.mockReset();
    createUntitledDocumentInDirectory.mockReset();
    deleteFableDocument.mockReset();
    renameFableDocument.mockReset();
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: "/tmp/Fables/story.fable",
      entries: [
        { kind: "folder", name: "Archive", path: "/tmp/Fables/Archive" },
        { kind: "document", name: "side-story.fable", path: "/tmp/Fables/side-story.fable" },
        { kind: "document", name: "story.fable", path: "/tmp/Fables/story.fable" },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });
    listFableDirectory.mockResolvedValue({
      currentDocumentPath: "/tmp/Fables/story.fable",
      entries: [
        { kind: "document", name: "story.fable", path: "/tmp/Fables/story.fable" },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });
    deleteFableDocument.mockResolvedValue(undefined);
    resetStores();
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    document.body.innerHTML = "";
    resetStores();
  });

  it("remembers a document's root card and a folder's document until vertical navigation", async () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.summary.path = "/tmp/Fables/story.fable";
    snapshot.cards.push({ documentId: "doc-1", id: "root-2", parentId: null, orderIndex: 1, type: "card" });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("root-2");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    async function press(key: string) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    }
    function explorer(label: string) {
      return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="directory-card"]'))
        .find((card) => card.textContent === label);
    }
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(explorer("FABLEstory")?.style.top).toBe("calc(50% + 0px)");
    await press("ArrowRight");
    expect(explorer("FABLEstory")?.dataset.isActive).toBe("true");
    await press("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("root-2");
    await press("ArrowLeft");
    await press("ArrowUp");
    await press("ArrowDown");
    await press("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    await press("ArrowLeft");
    await press("ArrowUp");
    await press("ArrowDown");
    await press("ArrowLeft");
    // Leaving story horizontally establishes a fresh return target.
    expect(explorer("FABLEstory")?.style.top).toBe("calc(50% + 0px)");
    await press("ArrowRight");
    expect(explorer("FABLEstory")?.dataset.isActive).toBe("true");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("keeps Tab and Shift+Tab from moving focus independently of directory selection", async () => {
    const snapshot = makeDocumentSnapshot();
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("card-root");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });

    for (const selection of ["file", "folder"]) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
      });
      const selectedCard = container.querySelector('[data-testid="directory-card"][data-is-active="true"]');
      expect(selectedCard).not.toBeNull();
      expect(Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'))
        .every(card => card.tabIndex === -1)).toBe(true);

      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey });
        await act(async () => { window.dispatchEvent(event); });
        expect(event.defaultPrevented, `${selection}, shift=${shiftKey}`).toBe(true);
        expect(container.querySelector('[data-testid="directory-card"][data-is-active="true"]')).toBe(selectedCard);
      }
    }

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("moves the lower section into a sibling, keeps editing at its start, and undoes the divide together", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Above\n\nBelow"),
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("card-a");
    useAppStore.setState({ mode: "editing" });
    const originalSnapshot = useDocumentStore.getState().snapshot;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    await act(async () => {
      (container.querySelector('[data-testid="card-editor-divide"]') as HTMLButtonElement).click();
    });

    const divided = useDocumentStore.getState().snapshot!;
    const newCardId = useInteractionStore.getState().activeCardId!;
    expect(divided.cards).toHaveLength(snapshot.cards.length + 1);
    expect(divided.cards.find((card) => card.id === newCardId)).toMatchObject({
      parentId: "card-root", orderIndex: 1,
    });
    expect(contentText(divided.contents.find((content) => content.cardId === "card-a")!.contentJson)).toBe("Above");
    expect(contentText(divided.contents.find((content) => content.cardId === newCardId)!.contentJson)).toBe("Below");
    expect(useAppStore.getState().mode).toBe("editing");
    expect(container.querySelector('[data-testid="card-editor"]')?.getAttribute("data-focus-placement")).toBe("start");
    await act(async () => { useDocumentStore.getState().undoNavigation(); });
    expect(useDocumentStore.getState().snapshot).toEqual(originalSnapshot);
    await act(async () => { useDocumentStore.getState().redoNavigation(); });
    expect(useDocumentStore.getState().snapshot).toEqual(divided);
    await act(async () => { root.unmount(); });
  });

  it("remembers nested folder children and restores a folder after ascending", async () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.summary.path = "/tmp/Fables/story.fable";
    const listing = (folderPath: string, entries: { kind: "folder" | "document"; name: string; path: string }[], parentFolderPath: string | null) => ({
      currentDocumentPath: snapshot.summary.path, entries, folderPath,
      folderName: folderPath.split("/").pop()!, parentFolderPath,
    });
    const files = listing("/tmp/Fables", [
      { kind: "folder", name: "Archive", path: "/tmp/Fables/Archive" },
      { kind: "document", name: "story.fable", path: snapshot.summary.path },
    ], "/tmp");
    const archive = listing("/tmp/Fables/Archive", [
      { kind: "folder", name: "First", path: "/tmp/Fables/Archive/First" },
      { kind: "document", name: "Second.fable", path: "/tmp/Fables/Archive/Second.fable" },
    ], "/tmp/Fables");
    listCurrentDocumentDirectory.mockResolvedValue(files);
    listFableDirectory.mockImplementation(async (path: string) =>
      path === files.folderPath ? files : path === archive.folderPath ? archive : listing("/tmp", [
        { kind: "folder", name: "Fables", path: "/tmp/Fables" },
      ], "/"));
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("card-root");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    async function press(key: string) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    }
    function explorer(label: string) {
      return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="directory-card"]'))
        .find((card) => card.textContent === label);
    }
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowRight");
    await press("ArrowUp");
    await press("ArrowRight");
    await press("ArrowDown");
    expect(explorer("FABLESecond")?.dataset.isActive).toBe("true");
    await press("ArrowLeft");
    expect(explorer("FABLESecond")?.style.top).toBe("calc(50% + 0px)");
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowRight");
    expect(explorer("FOLDERFables")?.dataset.isActive).toBe("true");
    await press("ArrowRight");
    expect(explorer("FOLDERArchive")?.dataset.isActive).toBe("true");
    await press("ArrowRight");
    expect(explorer("FOLDERArchive")?.dataset.isActive).toBe("true");
    await press("ArrowRight");
    expect(explorer("FABLESecond")?.dataset.isActive).toBe("true");
    await press("ArrowLeft");
    await press("ArrowDown");
    await press("ArrowUp");
    await press("ArrowRight");
    expect(explorer("FOLDERFirst")?.dataset.isActive).toBe("true");
    await press("ArrowLeft");
    await act(async () => { useInteractionStore.getState().rememberChild("folder:/tmp/Fables/Archive", "/deleted.fable"); });
    await press("ArrowRight");
    expect(explorer("FOLDERFirst")?.dataset.isActive).toBe("true");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("retraces horizontal movement and resets child alignment after vertical movement", async () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push(
      { documentId: "doc-1", id: "root-2", parentId: null, orderIndex: 1, type: "card" },
      { documentId: "doc-1", id: "b1", parentId: "card-b", orderIndex: 0, type: "card" },
      { documentId: "doc-1", id: "b2", parentId: "card-b", orderIndex: 1, type: "card" },
    );
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("b2");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    async function press(key: string) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    }
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    const rememberedPreview = container.querySelector('[data-card-label="B02"]');
    expect(rememberedPreview?.getAttribute("data-y")).toBe("0");
    await press("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    await press("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("b2");
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowDown");
    await press("ArrowUp");
    expect(useInteractionStore.getState().rememberedChildIds).toEqual({});
    await press("ArrowRight");
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("shows only ancestors, same-parent siblings, and direct children, updating on selection", async () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push(
      { ...snapshot.cards[0]!, id: "other-root", orderIndex: 1 },
      { ...snapshot.cards[1]!, id: "a-child", parentId: "card-a" },
      { ...snapshot.cards[1]!, id: "b-child", parentId: "card-b" },
      { ...snapshot.cards[1]!, id: "grandchild", parentId: "a-child" },
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({ activeDocument: snapshot.summary, mode: "navigation", screen: "workspace" });
    useInteractionStore.setState({ activeCardId: "card-a" });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    const labels = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="tree-card"]'))
      .map((card) => card.dataset.cardLabel).sort();
    expect(labels()).toEqual(["A01", "B02", "C01"]);
    // Includes the grandchild that is hidden in this writing view.
    expect(container.querySelector('[data-testid="active-card-shell"] .fc-descendant-count')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="parent-group-divider"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(labels()).toEqual(["A01", "B01", "C02"]);
    expect(container.querySelector('[data-testid="active-card-shell"] .fc-descendant-count')?.textContent).toBe("1");
    await act(async () => { useInteractionStore.getState().setActiveCardId("a-child"); });
    expect(labels()).toEqual(["A01", "B01", "D01"]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "-", metaKey: true }));
    });
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(7);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("keeps the active card shell footprint stable between navigation and editing", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {});

    const navigationShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;
    const navigationEditor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLDivElement | null;

    expect(navigationShell).not.toBeNull();
    expect(navigationEditor?.dataset.editing).toBe("false");
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);
    expect(navigationShell?.textContent).toContain("A01");

    const navigationStyle = {
      backgroundColor: navigationShell?.style.backgroundColor,
      borderWidth: navigationShell?.style.borderWidth,
      boxShadow: navigationShell?.style.boxShadow,
      minHeight: navigationShell?.style.minHeight,
      paddingBottom: navigationShell?.style.paddingBottom,
      paddingLeft: navigationShell?.style.paddingLeft,
      paddingRight: navigationShell?.style.paddingRight,
      paddingTop: navigationShell?.style.paddingTop,
    };

    await act(async () => {
      useAppStore.setState({ mode: "editing" });
    });

    const editingShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;
    const editingEditor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLDivElement | null;

    expect(editingShell).not.toBeNull();
    expect(editingEditor?.dataset.editing).toBe("true");
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);
    expect({
      minHeight: editingShell?.style.minHeight,
      paddingBottom: editingShell?.style.paddingBottom,
      paddingLeft: editingShell?.style.paddingLeft,
      paddingRight: editingShell?.style.paddingRight,
      paddingTop: editingShell?.style.paddingTop,
    }).toEqual({
      minHeight: navigationStyle.minHeight,
      paddingBottom: navigationStyle.paddingBottom,
      paddingLeft: navigationStyle.paddingLeft,
      paddingRight: navigationStyle.paddingRight,
      paddingTop: navigationStyle.paddingTop,
    });
    expect(navigationStyle.backgroundColor).toBe(
      "var(--fc-color-card-surface-active)",
    );
    expect(navigationStyle.boxShadow).toBe("var(--fc-shadow-elevated)");
    expect(editingShell?.style.backgroundColor).toBe(
      "var(--fc-color-card-surface-editing)",
    );
    expect(editingShell?.style.borderWidth).toBe(navigationStyle.borderWidth);
    expect(editingShell?.style.boxShadow).toBe(navigationStyle.boxShadow);
    expect(editingShell?.style.paddingTop).toBe("40px");
    expect(Array.from(container.querySelectorAll('[data-testid="tree-card"]')).map((node) =>
      (node as HTMLDivElement).dataset.cardLabel,
    )).toEqual(["B01", "B02"]);
    expect(Array.from(container.querySelectorAll('[data-testid="tree-card"]')).map((node) =>
      (node as HTMLDivElement).dataset.descendantCount,
    )).toEqual(["0", "0"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("moves from the root card to the containing folder and shows only folders plus fable files", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder", name: "Archive", path: "/tmp/Fables/Archive" },
        { kind: "document", name: "side-story.fable", path: "/tmp/Fables/side-story.fable" },
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });
    listFableDirectory.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/tmp/Fables/Archive"
          ? {
              currentDocumentPath: snapshot.summary.path,
              entries: [
                {
                  kind: "folder",
                  name: "Deep Notes",
                  path: "/tmp/Fables/Archive/Deep Notes",
                },
                {
                  kind: "document",
                  name: "archive-index.fable",
                  path: "/tmp/Fables/Archive/archive-index.fable",
                },
              ],
              folderName: "Archive",
              folderPath: "/tmp/Fables/Archive",
              parentFolderPath: "/tmp/Fables",
            }
          : {
              currentDocumentPath: snapshot.summary.path,
              entries: [
                {
                  kind: "document",
                  name: "story.fable",
                  path: snapshot.summary.path,
                },
              ],
              folderName: "Fables",
              folderPath: "/tmp/Fables",
              parentFolderPath: "/tmp",
            },
      ),
    );

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    expect(container.textContent).toContain("Story");
    expect(container.textContent).not.toContain("Fables");
    expect(container.textContent).not.toContain("FOLDER");
    expect(container.textContent).not.toContain("FABLE");
    expect(container.querySelector('[data-testid="document-title"]')?.textContent).toBe("Story");
    expect(container.textContent).not.toContain("side-story.fable");

    const initialDirectoryCards = Array.from(
      container.querySelectorAll('[data-testid="directory-card"]'),
    ) as HTMLButtonElement[];
    const documentCard = initialDirectoryCards.find((card) =>
      card.textContent?.includes("story"),
    );

    expect(initialDirectoryCards).toHaveLength(0);
    expect(documentCard).toBeUndefined();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowLeft",
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="tree-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="empty-child-gap"]')).toBeNull();
    expect(container.textContent).toContain("Fables");
    expect(container.textContent).toContain("story");
    expect(container.querySelector('[data-testid="document-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="directory-card"]')?.getAttribute("style")).toContain("234px");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowLeft",
        }),
      );
    });

    expect(container.textContent).toContain("Archive");
    expect(container.textContent).toContain("tmp");
    expect(container.textContent).toContain("side-story");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    await act(async () => {});

    // Horizontal return now selects story; explicitly move up to Archive.
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      });
    }
    expect(container.textContent).toContain("Deep Notes");
    expect(container.textContent).toContain("archive-index");
    expect(container.textContent).not.toContain(".fable");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows and navigates the containing folder's siblings after moving left from a file", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({ activeDocument: snapshot.summary, mode: "navigation", screen: "workspace" });
    useInteractionStore.setState({ activeCardId: "card-root" });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    const currentDirectory = await listCurrentDocumentDirectory();
    const parentDirectory = {
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder" as const, name: "Archive", path: "/tmp/Archive" },
        { kind: "folder" as const, name: "Fables", path: "/tmp/Fables" },
        { kind: "document" as const, name: "neighbour.fable", path: "/tmp/neighbour.fable" },
      ],
      folderName: "tmp",
      folderPath: "/tmp",
      parentFolderPath: "/",
    };
    listFableDirectory.mockImplementation(async (path: string) => {
      if (path === "/tmp") return parentDirectory;
      if (path === "/tmp/Archive") return {
        ...currentDirectory,
        entries: [],
        folderName: "Archive",
        folderPath: path,
        parentFolderPath: "/tmp",
      };
      return currentDirectory;
    });
    const explorerCard = (label: string) => Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
    ).find((card) => card.textContent === label);
    const press = async (key: string) => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    };
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    await press("ArrowLeft");
    await press("ArrowLeft");

    expect(listFableDirectory).toHaveBeenCalledWith("/tmp");
    expect(explorerCard("FOLDERFables")?.dataset.isActive).toBe("true");
    expect(explorerCard("FOLDERFables")?.style.top).toBe("calc(50% + 0px)");
    expect(explorerCard("FOLDERArchive")?.style.left).toBe("calc(50% + 0px)");
    expect(explorerCard("FOLDERArchive")?.style.top).not.toBe("calc(50% + 0px)");
    expect(explorerCard("FABLEneighbour")?.style.left).toBe("calc(50% + 0px)");
    expect(explorerCard("FABLEneighbour")?.style.top).not.toBe("calc(50% + 0px)");
    expect(explorerCard("FOLDERtmp")).toBeDefined();
    expect(explorerCard("FABLEstory")).toBeDefined();

    await press("ArrowUp");
    expect(explorerCard("FOLDERArchive")?.dataset.isActive).toBe("true");
    expect(explorerCard("FOLDERFables")).toBeDefined();
    await press("ArrowDown");
    expect(explorerCard("FOLDERFables")?.dataset.isActive).toBe("true");
    await press("ArrowRight");
    expect(explorerCard("FOLDERArchive")?.dataset.isActive).toBe("true");
    await press("ArrowLeft");
    await act(async () => { explorerCard("FABLEneighbour")?.click(); });
    expect(explorerCard("FABLEneighbour")?.dataset.isActive).toBe("true");
    expect(explorerCard("FOLDERFables")).toBeDefined();
    await act(async () => { root.unmount(); });
  });

  it("keeps root folder navigation usable without a parent listing", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({ activeDocument: snapshot.summary, mode: "navigation", screen: "workspace" });
    useInteractionStore.setState({ activeCardId: "card-root" });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [{ kind: "document", name: "story.fable", path: snapshot.summary.path }],
      folderName: "/",
      folderPath: "/",
      parentFolderPath: null,
    });
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    for (const key of ["ArrowLeft", "ArrowLeft", "ArrowUp", "ArrowDown", "ArrowLeft"]) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    }
    expect(listFableDirectory).not.toHaveBeenCalled();
    expect(container.querySelector('[data-is-active="true"][data-testid="directory-card"]')?.textContent).toBe("FOLDER/");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    expect(container.querySelector('[data-is-active="true"][data-testid="directory-card"]')?.textContent).toBe("FABLEstory");
    await act(async () => { root.unmount(); });
  });

  it("recenters folder and fable cards after panning when navigating or clicking", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector(
      '[data-testid="document-stage"]',
    ) as HTMLDivElement | null;
    const directoryCard = (text: string) =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
      ).find((card) => card.textContent === text);

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 90,
          deltaY: 30,
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    expect(directoryCard("FABLEstory")?.dataset.isActive).toBe("true");
    expect(directoryCard("FABLEstory")?.style.left).toBe("calc(50% + 0px)");
    expect(directoryCard("FABLEstory")?.style.top).toBe("calc(50% + 0px)");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    expect(directoryCard("FOLDERFables")?.dataset.isActive).toBe("true");
    expect(directoryCard("FOLDERFables")?.style.left).toBe("calc(50% + 0px)");
    expect(directoryCard("FOLDERFables")?.style.top).toBe("calc(50% + 0px)");

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: -60,
          deltaY: -24,
        }),
      );
    });

    await act(async () => {
      directoryCard("FOLDERArchive")?.click();
    });

    expect(directoryCard("FOLDERArchive")?.dataset.isActive).toBe("true");
    expect(directoryCard("FOLDERArchive")?.style.left).toBe("calc(50% + 0px)");
    expect(directoryCard("FOLDERArchive")?.style.top).toBe("calc(50% + 0px)");

    await act(async () => {
      root.unmount();
    });
  });

  it("renames the selected fable document with Enter and inline text", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      summary: {
        documentId: "doc-1",
        name: "story",
        openedAtMs: 1,
        path: "/tmp/Fables/story.fable",
      },
    };
    const renamedDocument = {
      documentId: "doc-1",
      name: "field notes",
      openedAtMs: 1,
      path: "/tmp/Fables/field notes.fable",
    };
    const onDocumentRenamed = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    renameFableDocument.mockResolvedValue(renamedDocument);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });
    listFableDirectory.mockResolvedValue({
      currentDocumentPath: renamedDocument.path,
      entries: [
        { kind: "document", name: "field notes.fable", path: renamedDocument.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });

    await act(async () => {
      root.render(
        <DocumentWorkspace
          document={snapshot.summary}
          onDocumentRenamed={onDocumentRenamed}
        />,
      );
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    const input = container.querySelector("input") as HTMLInputElement | null;

    expect(input?.value).toBe("story");

    await act(async () => {
      if (input) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "field notes");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await act(async () => {
      if (input) {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      }
    });

    expect(renameFableDocument).toHaveBeenCalledWith(
      "/tmp/Fables/story.fable",
      "field notes",
    );
    expect(onDocumentRenamed).toHaveBeenCalledWith(
      renamedDocument,
      "/tmp/Fables/story.fable",
    );
    expect(container.textContent).toContain("FABLEfield notes");
    expect(container.querySelector("input")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.querySelector('[data-testid="document-title"]')?.textContent).toBe("field notes");
    expect(container.querySelector('[data-testid="directory-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("cancels fable document rename with Escape", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      summary: {
        documentId: "doc-1",
        name: "story",
        openedAtMs: 1,
        path: "/tmp/Fables/story.fable",
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    const input = container.querySelector("input") as HTMLInputElement | null;

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });

    expect(renameFableDocument).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("FABLEstory");

    await act(async () => {
      root.unmount();
    });
  });

  it.each([
    ["folder", "escape"],
    ["current-file", "blank"],
    ["neighbour-file", "rename"],
    ["neighbour-folder", "escape"],
    ["preview-file", "rename"],
    ["preview-folder", "blank"],
  ].flatMap(([selection, naming]) =>
    ["ArrowRight", "ArrowUp", "ArrowDown"].map(creationKey => [selection, naming, creationKey]),
  ))("creates beside %s, handles %s naming with %s, and waits for Right to open", async (selection, naming, creationKey) => {
    const snapshot = makeDocumentSnapshot();
    snapshot.summary.path = "/tmp/Fables/story.fable";
    const targetFolder = selection.startsWith("preview") ? "/tmp/Fables/Archive" : "/tmp/Fables";
    const createdDocument = {
      documentId: "created-doc", name: "Untitled", openedAtMs: 2,
      path: `${targetFolder}/Untitled.fable`,
    };
    let created = false;
    let finalName = "Untitled";
    const listing = (path: string) => ({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder", name: "Archive", path: `${path}/Archive` },
        { kind: "document", name: "story.fable", path: `${path}/story.fable` },
        ...(created && path === targetFolder ? [{ kind: "document", name: `${finalName}.fable`, path: `${path}/${finalName}.fable` }] : []),
      ],
      folderName: path.endsWith("Archive") ? "Archive" : "Fables",
      folderPath: path,
      parentFolderPath: "/tmp",
    });
    listCurrentDocumentDirectory.mockResolvedValue(listing("/tmp/Fables"));
    listFableDirectory.mockImplementation(async (path: string) => listing(path));
    createUntitledDocumentInDirectory.mockImplementation(async () => {
      created = true;
      return createdDocument;
    });
    renameFableDocument.mockImplementation(async (_path: string, name: string) => {
      finalName = name;
      return { ...createdDocument, name, path: `${targetFolder}/${name}.fable` };
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.getState().setDocument(snapshot.summary);
    useInteractionStore.getState().setActiveCardId("card-root");
    const onOpenDocumentPath = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} onOpenDocumentPath={onOpenDocumentPath} />);
    });
    async function press(key: string, modifier: "meta" | "ctrl" | null = null) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, metaKey: modifier === "meta", ctrlKey: modifier === "ctrl" }));
      });
    }
    async function select(label: string) {
      const card = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'))
        .find(card => card.textContent === label);
      expect(card).toBeDefined();
      await act(async () => { card!.click(); });
    }
    await press("ArrowLeft");
    if (selection === "folder") await press("ArrowLeft");
    if (selection === "neighbour-file") await select("FABLEstory");
    if (selection === "neighbour-folder" || selection.startsWith("preview")) await select("FOLDERArchive");
    if (selection.startsWith("preview")) {
      await press("ArrowRight");
      if (selection === "preview-file") await press("ArrowDown");
    }
    await press(creationKey, creationKey === "ArrowRight" ? "meta" : "ctrl");

    expect(createUntitledDocumentInDirectory).toHaveBeenCalledWith(targetFolder);
    expect(onOpenDocumentPath).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeDocument?.documentId).toBe(snapshot.summary.documentId);
    expect(useDocumentStore.getState().snapshot?.summary.documentId).toBe(snapshot.summary.documentId);
    expect(useAppStore.getState().mode).toBe("navigation");
    expect(container.querySelector('[data-testid="tree-card"]')).toBeNull();
    const input = container.querySelector("input")!;
    expect(input.value).toBe("Untitled");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(async () => {
      if (naming !== "escape") {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, naming === "blank" ? "   " : "Field notes");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: naming === "escape" ? "Escape" : "Enter" }));
    });
    expect(container.querySelector("input")).toBeNull();
    expect(onOpenDocumentPath).not.toHaveBeenCalled();
    if (naming === "rename") expect(renameFableDocument).toHaveBeenCalledWith(createdDocument.path, "Field notes");
    else expect(renameFableDocument).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="directory-card"][data-is-active="true"]')?.textContent).toBe(`FABLE${finalName}`);
    await press("ArrowRight");
    expect(onOpenDocumentPath).toHaveBeenCalledWith(`${targetFolder}/${finalName}.fable`);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("ignores duplicate creation shortcuts while pending and allows retry after failure", async () => {
    const snapshot = makeDocumentSnapshot();
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("card-root");
    let rejectCreation!: (error: Error) => void;
    createUntitledDocumentInDirectory.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCreation = reject; }));
    const createdDocument = { documentId: "new-doc", name: "Untitled", openedAtMs: 2, path: "/tmp/Fables/Untitled.fable" };
    createUntitledDocumentInDirectory.mockResolvedValueOnce(createdDocument);
    const onOpenDocumentPath = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} onOpenDocumentPath={onOpenDocumentPath} />);
    });
    async function press(key: string, ctrlKey = false) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ctrlKey }));
      });
    }
    await press("ArrowLeft");
    await press("ArrowRight", true);
    await press("ArrowRight", true);
    expect(createUntitledDocumentInDirectory).toHaveBeenCalledTimes(1);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => { rejectCreation(new Error("Could not create file.")); });
    log.mockRestore();
    expect(container.querySelector('[data-testid="directory-load-error"]')?.textContent).toBe("Could not create file.");
    expect(container.querySelector("input")).toBeNull();
    expect(onOpenDocumentPath).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().snapshot?.summary.documentId).toBe(snapshot.summary.documentId);
    await press("ArrowRight", true);
    expect(createUntitledDocumentInDirectory).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Untitled");
    expect(onOpenDocumentPath).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("confirms before deleting a selected sibling fable document", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder", name: "Archive", path: "/tmp/Fables/Archive" },
        { kind: "document", name: "side-story.fable", path: "/tmp/Fables/side-story.fable" },
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });
    listFableDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder", name: "Archive", path: "/tmp/Fables/Archive" },
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    });

    expect(container.textContent).toContain("FABLEside-story");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    });

    expect(container.textContent).toContain("Move Document to Trash");
    expect(container.textContent).toContain(
      "Move \"side-story\" and all its contents to Trash?",
    );
    expect(container.textContent).not.toContain("This cannot be undone");
    expect(container.textContent).not.toContain("Escape cancels");

    const cancelButton = container.querySelector(
      '[data-testid="cancel-delete-document"]',
    ) as HTMLButtonElement | null;
    const deleteButton = container.querySelector(
      '[data-testid="confirm-delete-document"]',
    ) as HTMLButtonElement | null;

    expect(cancelButton?.className).toContain("rounded-[var(--fc-radius-pill)]");
    expect(deleteButton?.className).toContain("rounded-[var(--fc-radius-pill)]");
    expect(cancelButton?.getAttribute("aria-pressed")).toBe("true");
    expect(deleteButton?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      cancelButton?.click();
    });

    expect(deleteFableDocument).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Move Document to Trash");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    const selectedDeleteButton = container.querySelector(
      '[data-testid="confirm-delete-document"]',
    ) as HTMLButtonElement | null;

    expect(selectedDeleteButton?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    await act(async () => {});

    expect(deleteFableDocument).toHaveBeenCalledWith("/tmp/Fables/side-story.fable");
    expect(container.textContent).not.toContain("FABLEside-story");
    expect(useAppStore.getState().notice?.message).toBe("Moved \"side-story\" to Trash.");

    await act(async () => {
      root.unmount();
    });
  });

  it.each([true, false])("handles trashing the current document (success=%s)", async (success) => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      summary: {
        documentId: "doc-1",
        name: "story",
        openedAtMs: 1,
        path: "/tmp/Fables/story.fable",
      },
    };
    if (!success) deleteFableDocument.mockRejectedValue({
      code: "document_trash_failed",
      message: "Trash unavailable",
      details: "Path: /tmp/Fables/story.fable\nSystem error: Permission denied (os error 13)",
    });
    const onDocumentDeleted = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "document", name: "story.fable", path: snapshot.summary.path },
      ],
      folderName: "Fables",
      folderPath: "/tmp/Fables",
      parentFolderPath: "/tmp",
    });

    await act(async () => {
      root.render(
        <DocumentWorkspace
          document={snapshot.summary}
          onDocumentDeleted={onDocumentDeleted}
        />,
      );
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
    });

    expect(container.textContent).toContain("Move Document to Trash");

    await act(async () => {
      (
        container.querySelector('[data-testid="confirm-delete-document"]') as HTMLButtonElement | null
      )?.click();
    });

    expect(deleteFableDocument).toHaveBeenCalledWith(snapshot.summary.path);
    if (success) {
      expect(onDocumentDeleted).toHaveBeenCalledWith(snapshot.summary.path);
    } else {
      expect(onDocumentDeleted).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="delete-document-error"]')?.textContent).toBe(
        "Trash unavailable\n\nPath: /tmp/Fables/story.fable\nSystem error: Permission denied (os error 13)",
      );
      expect(useDocumentStore.getState().snapshot?.summary.path).toBe(snapshot.summary.path);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("moves right from a folder entry to its fable child before entering the document tree", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      summary: {
        documentId: "doc-1",
        name: "Robotics",
        openedAtMs: 1,
        path: "/tmp/Frontier/Robotics/Robotics.fable",
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    listCurrentDocumentDirectory.mockResolvedValue({
      currentDocumentPath: snapshot.summary.path,
      entries: [
        { kind: "folder", name: "Design", path: "/tmp/Frontier/Design" },
        { kind: "folder", name: "Robotics", path: "/tmp/Frontier/Robotics" },
      ],
      folderName: "Frontier",
      folderPath: "/tmp/Frontier",
      parentFolderPath: "/tmp",
    });
    listFableDirectory.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/tmp/Frontier/Robotics"
          ? {
              currentDocumentPath: snapshot.summary.path,
              entries: [
                {
                  kind: "document",
                  name: "Robotics.fable",
                  path: snapshot.summary.path,
                },
                {
                  kind: "document",
                  name: "Scratchpad.fable",
                  path: "/tmp/Frontier/Robotics/Scratchpad.fable",
                },
              ],
              folderName: "Robotics",
              folderPath: "/tmp/Frontier/Robotics",
              parentFolderPath: "/tmp/Frontier",
            }
          : {
              currentDocumentPath: snapshot.summary.path,
              entries: [],
              folderName: "Frontier",
              folderPath: "/tmp/Frontier",
              parentFolderPath: "/tmp",
            },
      ),
    );

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    const currentDocumentCard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
    ).find((card) => card.textContent === "FABLERobotics");
    const containingFolderCard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
    ).find((card) => card.textContent === "FOLDERFrontier");

    expect(currentDocumentCard?.dataset.isActive).toBe("true");
    expect(currentDocumentCard?.style.left).toBe("calc(50% + 0px)");
    expect(containingFolderCard?.style.left).toBe("calc(50% + -258px)");
    expect(containingFolderCard?.style.top).toBe("calc(50% + 0px)");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    await act(async () => {});

    const selectedFolderCard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
    ).find((card) => card.textContent === "FOLDERRobotics");
    const firstPreviewChildCard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="directory-card"]'),
    ).find((card) => card.textContent === "FABLERobotics");

    expect(selectedFolderCard?.dataset.isActive).toBe("true");
    expect(selectedFolderCard?.style.left).toBe("calc(50% + 0px)");
    expect(selectedFolderCard?.style.top).toBe("calc(50% + 0px)");
    expect(firstPreviewChildCard?.style.top).toBe("calc(50% + 0px)");
    expect(container.textContent).toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="tree-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).toContain("FOLDERRobotics");
    expect(container.textContent).toContain("FABLERobotics");
    expect(container.textContent).toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="tree-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).not.toContain("FOLDERRobotics");
    expect(container.textContent).not.toContain("FABLERobotics");
    expect(container.textContent).not.toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-title"]')?.textContent).toBe("Robotics");
    expect(container.querySelector('[data-testid="directory-card"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).not.toContain("FOLDERRobotics");
    expect(container.textContent).not.toContain("FABLERobotics");
    expect(container.textContent).not.toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-title"]')?.textContent).toBe("Robotics");
    expect(container.querySelector('[data-testid="directory-card"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    expect(container.querySelector('[data-testid="document-title"]')).toBeNull();
    expect(container.querySelector('[data-is-active="true"][data-testid="directory-card"]')?.textContent).toBe("FABLERobotics");
    expect(container.textContent).toContain("FOLDERRobotics");
    expect(container.textContent).toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="tree-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses normal text padding for a new empty card", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-a",
      contentJson: NEW_CARD_EDITOR_DOCUMENT_JSON,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const activeShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;

    expect(activeShell?.style.paddingTop).toBe("40px");
    expect(activeShell?.style.paddingBottom).toBe("23px");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the top of oversized navigation cards visible and the bottom of oversized editing cards visible", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 720,
    });
    mockLayoutHeight((element) => {
      const activeCardId = useInteractionStore.getState().activeCardId;

      return element.dataset.testid === "active-card-shell" && activeCardId === "card-a"
        ? 1200
        : 84;
    });

    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    const navigationShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(navigationShell?.offsetHeight).toBe(1200);
    expect(navigationShell?.style.minHeight).toBe("84px");
    expect(navigationShell?.style.top).toBe("48px");
    expect(navigationShell?.style.transform).toBe("translateX(-50%)");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    const editingShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;

    expect(useAppStore.getState().mode).toBe("editing");
    expect(editingShell?.style.top).toBe("-528px");
    expect(editingShell?.style.transform).toBe("translateX(-50%)");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Cmd/Ctrl minus and plus to enter and exit title-only overview", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene\n\nBody copy"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector(
      '[data-testid="document-stage"]',
    ) as HTMLDivElement | null;

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 140,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 600,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(overviewCards).toHaveLength(3);
    expect(overviewCards.every((card) => card.dataset.titleOnly === "true")).toBe(true);
    const overviewConnectors = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    expect(overviewConnectors).toHaveLength(2);
    expect(overviewConnectors.every((connector) =>
      connector.getAttribute("stroke") === "var(--fc-color-overview-connector-active)",
    )).toBe(true);
    expect(overviewConnectors.every((connector) =>
      connector.getAttribute("data-highlighted") === "true",
    )).toBe(true);
    expect(overviewConnectors[0]?.hasAttribute("stroke-opacity")).toBe(false);
    expect(overviewConnectors[0]?.getAttribute("stroke-width")).toBe(
      "4.5",
    );
    const initialOverviewScale = overviewCards[0]?.dataset.scale;
    expect(overviewCards.find((card) => card.dataset.isActive === "true")?.dataset.x).toBe("0");
    expect(overviewCards.find((card) => card.dataset.isActive === "true")?.dataset.y).toBe("0");

    await act(async () => {
      overviewCards[1]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");

    const selectedOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(selectedOverviewCard?.dataset.cardLabel).toBe("B01");
    expect(selectedOverviewCard?.dataset.descendantCount).toBe("0");
    expect(selectedOverviewCard?.dataset.scale).toBe(initialOverviewScale);
    expect(selectedOverviewCard?.dataset.x).toBe("0");
    expect(selectedOverviewCard?.dataset.y).toBe("0");
    const connectorsAfterSelection = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    const parentConnector = connectorsAfterSelection.find(
      (connector) => connector.getAttribute("data-child-card-id") === "card-a",
    );
    const siblingConnector = connectorsAfterSelection.find(
      (connector) => connector.getAttribute("data-child-card-id") === "card-b",
    );

    expect(parentConnector?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(parentConnector?.getAttribute("data-highlighted")).toBe("true");
    expect(siblingConnector?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector)",
    );
    expect(siblingConnector?.getAttribute("data-highlighted")).toBe("false");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("darkens overview connectors through the selected card descendant subtree", async () => {
    const baseSnapshot = makeDocumentSnapshot();
    const snapshot = {
      ...baseSnapshot,
      cards: [
        ...baseSnapshot.cards,
        {
          documentId: "doc-1",
          id: "card-a-1",
          orderIndex: 0,
          parentId: "card-a",
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-a-1-1",
          orderIndex: 0,
          parentId: "card-a-1",
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
        {
          cardId: "card-a-1",
          contentJson: contentJsonForPlainText("Nested Branch"),
        },
        {
          cardId: "card-a-1-1",
          contentJson: contentJsonForPlainText("Deep Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const connectors = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    const connectorForChild = (cardId: string) =>
      connectors.find(
        (connector) => connector.getAttribute("data-child-card-id") === cardId,
      );

    expect(connectorForChild("card-a")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-a-1")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-a-1-1")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-b")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector)",
    );
    expect(connectorForChild("card-a-1-1")?.getAttribute("data-highlighted")).toBe(
      "true",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("pans the overview graph during wheel gestures without changing focus", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector(
      '[data-testid="document-stage"]',
    ) as HTMLDivElement | null;

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const activeOverviewCard = () =>
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).find(
        (card) => (card as HTMLDivElement).dataset.isActive === "true",
      ) as HTMLDivElement | undefined;

    const initialScale = activeOverviewCard()?.dataset.scale;

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 48,
          deltaY: 12,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(activeOverviewCard()?.dataset.scale).toBe(initialScale);
    expect(activeOverviewCard()?.dataset.x).toBe("-48");
    expect(activeOverviewCard()?.dataset.y).toBe("-12");
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(
      (container.querySelector('[data-testid="overview-connectors"]') as SVGElement | null)
        ?.style.transform,
    ).toBe("translate(-48px, -12px)");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the fixed overview scale instead of deriving scale from the current full-card height", async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const element = this as HTMLElement;
      const isActiveShell = element.dataset.testid === "active-card-shell";

      return {
        bottom: isActiveShell ? 1200 : 84,
        height: isActiveShell ? 1200 : 84,
        left: 0,
        right: 468,
        toJSON() {
          return {};
        },
        top: 0,
        width: 468,
        x: 0,
        y: 0,
      } as DOMRect;
    };

    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Very Tall Root"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const activeOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(activeOverviewCard?.dataset.scale).toBe("0.82");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const nextActiveOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(nextActiveOverviewCard?.dataset.scale).toBe("0.82");

    await act(async () => {
      root.unmount();
    });
  });

  it("recenters the active card after arrow navigation from a panned workspace", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector('[data-testid="document-stage"]');

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 48,
          deltaY: 12,
        }),
      );
    });

    const pannedShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;
    expect(pannedShell?.style.left).toBe("calc(50% + -48px)");
    expect(pannedShell?.style.top).toBe("calc(50% + -12px)");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 24,
          deltaY: 24,
        }),
      );
    });

    const recenteredShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(recenteredShell?.style.left).toBe("calc(50% + 0px)");
    expect(recenteredShell?.style.top).toBe("calc(50% + 0px)");

    await act(async () => {
      root.unmount();
    });
  });

  it("hides neighbor cards without blocking arrow navigation", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    useSettingsStore.getState().setNeighborCards("hidden");
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Enter in overview to return to the normal view on the selected card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    expect(overviewCards).toHaveLength(3);

    await act(async () => {
      overviewCards[2]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(useAppStore.getState().mode).toBe("navigation");
    expect(container.querySelector('[data-testid="card-editor"]')?.getAttribute("data-editing")).toBe("false");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses native zoom menu actions to enter and exit overview", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-out");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).every(
        (card) => (card as HTMLDivElement).dataset.titleOnly === "true",
      ),
    ).toBe(true);

    await act(async () => {
      dispatchNativeMenuAction("zoom-in");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).every(
        (card) => (card as HTMLDivElement).dataset.titleOnly === "false",
      ),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("allows zoom menu actions while the command palette is open", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "command",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-out");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      useAppStore.setState({ mode: "command" });
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-in");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("releases estimated and cached heights when the active content is shorter", async () => {
    let naturalHeight = 240;
    let notifyResize = () => {};
    globalThis.ResizeObserver = class extends ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        super();
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
    } as unknown as typeof ResizeObserver;
    // Model actual browser layout: min-height can stretch a short card, so
    // measuring a surface constrained by its own cache cannot shrink it.
    mockLayoutHeight((element) => element.dataset.testid === "active-card-shell"
      ? Math.max(naturalHeight, Number.parseFloat(element.style.minHeight) || 0)
      : 84);
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Text that wraps more tightly than estimated. ".repeat(25)),
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);
    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useInteractionStore.getState().setActiveCardId("card-a");
    useAppStore.setState({ mode: "editing" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<DocumentWorkspace document={snapshot.summary} />); });
    await act(async () => { notifyResize(); });
    const shell = container.querySelector('[data-testid="active-card-shell"]') as HTMLElement;
    const followingSiblingY = () => Number(Array.from(container.querySelectorAll<HTMLElement>('[data-testid="tree-card"]'))
      .find((card) => card.dataset.cardLabel === "B02")?.dataset.y);
    expect(shell.offsetHeight).toBe(240);
    const originalSiblingY = followingSiblingY();

    await act(async () => {
      naturalHeight = 700;
      notifyResize();
    });
    expect(shell.offsetHeight).toBe(700);
    expect(followingSiblingY()).toBeGreaterThan(originalSiblingY);

    await act(async () => {
      naturalHeight = 120;
      useDocumentStore.getState().updateSnapshot((current) => replaceCardContent(current, {
        cardId: "card-a", contentJson: contentJsonForPlainText("Shortened after splitting or deleting text."),
      }));
      notifyResize();
    });
    expect(shell.offsetHeight).toBe(120);
    expect(followingSiblingY()).toBeLessThan(originalSiblingY);
    await act(async () => { root.unmount(); });
  });

  it("remeasures a card selected in overview before restoring normal sibling spacing", async () => {
    mockLayoutHeight((element) => {
      const activeCardId = useInteractionStore.getState().activeCardId;

      return element.dataset.testid === "active-card-shell" && activeCardId === "card-a"
        ? 420
        : 84;
    });

    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Tall Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Following Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    await act(async () => {
      overviewCards[1]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    const inactiveCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];
    const followingSibling = inactiveCards.find(
      (card) => card.dataset.cardLabel === "B02",
    );

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(followingSibling?.dataset.y).toBe("281");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses content height estimates for neighbors when returning from overview", async () => {
    const longText =
      "A long neighboring card that should reserve more than the minimum card height. " +
      "It has enough prose to wrap across several lines before the DOM measurement arrives, " +
      "so the restored normal view should not pack it like a tiny overview card.";
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText(longText),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Focused Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    await act(async () => {
      overviewCards[2]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    const previousSibling = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.cardLabel === "B01") as
      | HTMLDivElement
      | undefined;

    expect(Number(previousSibling?.dataset.y)).toBeLessThan(-180);

    await act(async () => {
      root.unmount();
    });
  });

  it("suspends workspace keyboard navigation while an overlay is open", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(
        <DocumentWorkspace
          document={snapshot.summary}
          suspendKeyboard
        />,
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Shift+Right to indent the active card under the sibling above", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
          shiftKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const cardAChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-a")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-a"]);
    expect(cardAChildren?.map((card) => card.id)).toEqual(["card-b"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty second root card on Backspace and keeps the first root placeholder semantics", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const deleteButton = container.querySelector(
      '[data-testid="card-editor-delete-empty"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      deleteButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty root-level card when Escape leaves editing", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("returns to the parent after Backspace deletes an empty child card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Parent"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Existing child"),
        },
        {
          cardId: "card-b",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const deleteButton = container.querySelector(
      '[data-testid="card-editor-delete-empty"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      deleteButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual([
      "card-root",
      "card-a",
    ]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("returns to the parent after Escape deletes an empty child card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Parent"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Existing child"),
        },
        {
          cardId: "card-b",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual([
      "card-root",
      "card-a",
    ]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("trims a trailing empty line when Escape leaves a non-empty card", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root",
      contentJson: JSON.stringify({
        content: [
          { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
          { type: "paragraph" },
        ],
        type: "doc",
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextContentJson =
      useDocumentStore
        .getState()
        .snapshot?.contents.find((content) => content.cardId === "card-root")
        ?.contentJson ?? "";

    expect(contentText(nextContentJson)).toBe("Keep");
    expect(JSON.parse(nextContentJson)).toEqual({
      content: [
        { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    });
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty root-level card before ArrowUp moves editing to the previous root card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateAboveButton = container.querySelector(
      '[data-testid="card-editor-navigate-above"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateAboveButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("trims the current card before edit-mode navigation focuses a child", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root",
      contentJson: JSON.stringify({
        content: [
          { content: [{ text: "Root", type: "text" }], type: "paragraph" },
          { type: "paragraph" },
        ],
        type: "doc",
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateChildEndButton = container.querySelector(
      '[data-testid="card-editor-navigate-child-end"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateChildEndButton?.click();
    });

    const nextContentJson =
      useDocumentStore
        .getState()
        .snapshot?.contents.find((content) => content.cardId === "card-root")
        ?.contentJson ?? "";

    expect(contentText(nextContentJson)).toBe("Root");
    expect(JSON.parse(nextContentJson)).toEqual({
      content: [
        { content: [{ text: "Root", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps edit mode and places focus at the end after Tab+ArrowRight navigates to a child", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Child"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Sibling"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateChildEndButton = container.querySelector(
      '[data-testid="card-editor-navigate-child-end"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateChildEndButton?.click();
    });

    const editor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLElement | null;

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.dataset.focusPlacement).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("creates and focuses a sibling below from edit-mode Tab+ArrowDown fallback", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Last scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const createSiblingBelowButton = container.querySelector(
      '[data-testid="card-editor-create-sibling-below"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      createSiblingBelowButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const newCardId = useInteractionStore.getState().activeCardId;
    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(rootChildren).toHaveLength(3);
    expect(rootChildren?.[2]?.id).toBe(newCardId);
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the final remaining card and empties it when deleting in navigation mode", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Only card"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Backspace",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(
      isContentEffectivelyEmpty(nextSnapshot?.contents[0]?.contentJson ?? ""),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Shift+Down to move a nested card into the next parent group in the same column", async () => {
    let snapshot = makeDocumentSnapshot();
    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Act one"),
    });
    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Act two"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat(
        {
          documentId: "doc-1",
          id: "card-a-1",
          orderIndex: 0,
          parentId: "card-a",
          type: "card",
        },
        {
          documentId: "doc-1",
          id: "card-b-1",
          orderIndex: 0,
          parentId: "card-b",
          type: "card",
        },
      ),
      contents: snapshot.contents.concat(
        {
          cardId: "card-a-1",
          contentJson: contentJsonForPlainText("Beat one"),
        },
        {
          cardId: "card-b-1",
          contentJson: contentJsonForPlainText("Beat two"),
        },
      ),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a-1",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
          shiftKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const cardAChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-a")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const cardBChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-b")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(cardAChildren).toHaveLength(0);
    expect(cardBChildren?.map((card) => [card.id, card.orderIndex])).toEqual([
      ["card-b-1", 0],
      ["card-a-1", 1],
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Option+Up to merge the sibling above into the active card", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "ArrowUp",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-b"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Option+Down to merge the sibling below into the active card", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-a"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      root.unmount();
    });
  });

  it("starts editing and forwards the typed character when text is pressed in navigation mode", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "a",
        }),
      );
    });

    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-pending-text-input")).toBe("a");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an italic empty-card placeholder only after leaving editing empty", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    let editor = container.querySelector('[data-testid="card-editor"]');

    expect(editor?.getAttribute("data-placeholder")).toBe("");

    await act(async () => {
      useAppStore.setState({ mode: "navigation" });
    });

    editor = container.querySelector('[data-testid="card-editor"]');

    expect(editor?.getAttribute("data-placeholder")).toBe("empty card");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Tab+ArrowDown to create a sibling below and focus it in edit mode", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const newCardId = useInteractionStore.getState().activeCardId;
    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(rootChildren).toHaveLength(3);
    expect(rootChildren?.[1]?.id).toBe(newCardId);
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");
    expect(editor?.getAttribute("data-placeholder")).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("lets Cmd+ArrowDown fall through without creating a sibling", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
          metaKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren).toHaveLength(2);
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders an empty child gap for a selected card without children and uses it to create a child", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Scene"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat({
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      }),
      contents: snapshot.contents.concat({
        cardId: "card-a-1",
        contentJson: contentJsonForPlainText("Beat"),
      }),
    };

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const gap = container.querySelector(
      '[data-testid="empty-child-gap"]',
    ) as HTMLButtonElement | null;

    expect(gap).not.toBeNull();
    expect(gap?.style.minHeight).toBeTruthy();

    await act(async () => {
      gap?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const cardBChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-b")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(cardBChildren).toHaveLength(1);
    expect(useInteractionStore.getState().activeCardId).toBe(cardBChildren?.[0]?.id);
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("copies selected card content in navigation mode without mutating the document", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Copied scene"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat({
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      }),
      contents: snapshot.contents.concat({
        cardId: "card-a-1",
        contentJson: contentJsonForPlainText("Child should not be copied"),
      }),
    };

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const { data, event } = createClipboardEvent("copy");

    await act(async () => {
      window.dispatchEvent(event);
    });

    const payload = decodeCardClipboardPayload(
      data.get(CARD_CLIPBOARD_MIME_TYPE) ?? "",
    );

    expect(event.defaultPrevented).toBe(true);
    expect(payload?.kind).toBe("content");
    expect(payload?.rootContentJson).toBe(contentJsonForPlainText("Copied scene"));
    expect(payload).not.toHaveProperty("descendants");
    expect(useDocumentStore.getState().navigationPast).toHaveLength(0);
    expect(useDocumentStore.getState().dirty).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("cuts the selected card subtree immediately in navigation mode", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Cut scene"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat({
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      }),
      contents: snapshot.contents.concat({
        cardId: "card-a-1",
        contentJson: contentJsonForPlainText("Cut child"),
      }),
    };

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const { data, event } = createClipboardEvent("cut");

    await act(async () => {
      window.dispatchEvent(event);
    });

    const payload = decodeCardClipboardPayload(
      data.get(CARD_CLIPBOARD_MIME_TYPE) ?? "",
    );
    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(event.defaultPrevented).toBe(true);
    expect(payload?.kind).toBe("subtree");
    expect(payload && "descendants" in payload ? payload.descendants.map((card) => card.id) : []).toEqual([
      "card-a-1",
    ]);
    expect(nextSnapshot?.cards.some((card) => card.id === "card-a")).toBe(false);
    expect(nextSnapshot?.cards.some((card) => card.id === "card-a-1")).toBe(false);
    expect(rootChildren?.map((card) => card.id)).toEqual(["card-b"]);
    expect(useDocumentStore.getState().navigationPast).toHaveLength(1);
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      root.unmount();
    });
  });

  it("pastes copied card content into an empty target card", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Copied scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const copy = createClipboardEvent("copy");

    await act(async () => {
      window.dispatchEvent(copy.event);
    });

    await act(async () => {
      useInteractionStore.setState({
        activeCardId: "card-b",
      });
    });

    const paste = createClipboardEvent("paste", {
      [CARD_CLIPBOARD_MIME_TYPE]: copy.data.get(CARD_CLIPBOARD_MIME_TYPE) ?? "",
      "text/plain": copy.data.get("text/plain") ?? "",
    });

    await act(async () => {
      window.dispatchEvent(paste.event);
    });

    const nextContentJson = useDocumentStore
      .getState()
      .snapshot?.contents.find((content) => content.cardId === "card-b")?.contentJson;

    expect(paste.event.defaultPrevented).toBe(true);
    expect(contentText(nextContentJson ?? "")).toBe("Copied scene");
    expect(useDocumentStore.getState().navigationPast).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("pastes copied card content into a new card below an occupied target", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Copied scene"),
    });
    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Occupied scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const copy = createClipboardEvent("copy");

    await act(async () => {
      window.dispatchEvent(copy.event);
    });

    await act(async () => {
      useInteractionStore.setState({
        activeCardId: "card-b",
      });
    });

    const paste = createClipboardEvent("paste", {
      "text/plain": copy.data.get("text/plain") ?? "",
    });

    await act(async () => {
      window.dispatchEvent(paste.event);
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const pastedContent = nextSnapshot?.contents.find(
      (content) =>
        content.cardId !== "card-a" &&
        content.contentJson === contentJsonForPlainText("Copied scene"),
    );
    const pastedCard = nextSnapshot?.cards.find(
      (card) => card.id === pastedContent?.cardId,
    );
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(paste.event.defaultPrevented).toBe(true);
    expect(contentText(nextSnapshot?.contents.find((content) => content.cardId === "card-b")?.contentJson ?? "")).toBe("Occupied scene");
    expect(pastedCard?.parentId).toBe("card-root");
    expect(rootChildren?.map((card) => card.id)).toEqual([
      "card-a",
      "card-b",
      pastedCard?.id,
    ]);
    expect(useInteractionStore.getState().activeCardId).toBe(pastedCard?.id);
    expect(useDocumentStore.getState().navigationPast).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("pastes a cut subtree into another document's empty card", async () => {
    let sourceSnapshot = makeDocumentSnapshot();
    const destinationSnapshot = {
      ...makeDocumentSnapshot(),
      cards: makeDocumentSnapshot().cards.map((card) => ({
        ...card,
        documentId: "doc-2",
      })),
      contents: makeDocumentSnapshot().contents,
      summary: {
        documentId: "doc-2",
        name: "Destination",
        openedAtMs: 2,
        path: "/tmp/destination.fable",
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    sourceSnapshot = replaceCardContent(sourceSnapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Moved scene"),
    });
    sourceSnapshot = {
      ...sourceSnapshot,
      cards: sourceSnapshot.cards.concat({
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      }),
      contents: sourceSnapshot.contents.concat({
        cardId: "card-a-1",
        contentJson: contentJsonForPlainText("Moved child"),
      }),
    };

    useDocumentStore.getState().hydrateSnapshot(sourceSnapshot);
    useAppStore.setState({
      activeDocument: sourceSnapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(sourceSnapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={sourceSnapshot.summary} />);
    });

    const cut = createClipboardEvent("cut");

    await act(async () => {
      window.dispatchEvent(cut.event);
    });

    loadCurrentDocumentSnapshot.mockResolvedValue(destinationSnapshot);
    await act(async () => {
      useDocumentStore.getState().hydrateSnapshot(destinationSnapshot);
      useAppStore.setState({
        activeDocument: destinationSnapshot.summary,
        mode: "navigation",
        notice: null,
        screen: "workspace",
      });
      useInteractionStore.setState({
        activeCardId: "card-b",
      });
    });

    await act(async () => {
      root.render(<DocumentWorkspace document={destinationSnapshot.summary} />);
    });

    await act(async () => {});

    const paste = createClipboardEvent("paste", {
      [CARD_CLIPBOARD_MIME_TYPE]: cut.data.get(CARD_CLIPBOARD_MIME_TYPE) ?? "",
      "text/plain": cut.data.get("text/plain") ?? "",
    });

    await act(async () => {
      window.dispatchEvent(paste.event);
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const pastedChildren = nextSnapshot?.cards.filter((card) => card.parentId === "card-b") ?? [];

    expect(contentText(nextSnapshot?.contents.find((content) => content.cardId === "card-b")?.contentJson ?? "")).toBe("Moved scene");
    expect(pastedChildren).toHaveLength(1);
    expect(pastedChildren[0]?.documentId).toBe("doc-2");
    expect(contentText(nextSnapshot?.contents.find((content) => content.cardId === pastedChildren[0]?.id)?.contentJson ?? "")).toBe("Moved child");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not intercept copy, cut, or paste while editing", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Editing scene"),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    for (const type of ["copy", "cut", "paste"] as const) {
      const { data, event } = createClipboardEvent(type, {
        "text/plain": "plain text",
      });

      await act(async () => {
        window.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      expect(data.get(CARD_CLIPBOARD_MIME_TYPE)).toBeUndefined();
    }

    expect(useDocumentStore.getState().dirty).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores card clipboard operations while folder context is selected", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root",
      contentJson: contentJsonForPlainText("Root scene"),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    const cut = createClipboardEvent("cut");

    await act(async () => {
      window.dispatchEvent(cut.event);
    });

    expect(cut.event.defaultPrevented).toBe(false);
    expect(useDocumentStore.getState().snapshot?.cards.some((card) => card.id === "card-root")).toBe(true);
    expect(useDocumentStore.getState().navigationPast).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });
});
