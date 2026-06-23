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
    onDeleteEmpty,
    onNavigateAbove,
    onNavigateChild,
    placeholder,
    pendingTextInput,
  }: {
    focusPlacement?: string | null;
    isEditing: boolean;
    onCreateSiblingBelow?: () => void;
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
    parentCardLabel,
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
    parentCardLabel?: string;
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
      data-parent-card-label={parentCardLabel ?? ""}
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
      (node as HTMLDivElement).dataset.parentCardLabel,
    )).toEqual(["A01", "A01"]);

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

    expect(container.textContent).toContain("story");
    expect(container.textContent).not.toContain("Fables");
    expect(container.textContent).not.toContain("FOLDER");
    expect(container.textContent).toContain("FABLE");
    expect(container.textContent).not.toContain("side-story.fable");

    const initialDirectoryCards = Array.from(
      container.querySelectorAll('[data-testid="directory-card"]'),
    ) as HTMLButtonElement[];
    const documentCard = initialDirectoryCards.find((card) =>
      card.textContent?.includes("story"),
    );

    expect(documentCard?.style.width).toBe("234px");
    expect(documentCard?.textContent).not.toContain(".fable");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowLeft",
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(container.textContent).toContain("Fables");
    expect(container.textContent).toContain("story");

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

    expect(container.textContent).toContain("Deep Notes");
    expect(container.textContent).toContain("archive-index");
    expect(container.textContent).not.toContain(".fable");

    await act(async () => {
      root.unmount();
    });
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

  it("creates an untitled fable document from the folder card with Ctrl+Right", async () => {
    const snapshot = makeDocumentSnapshot();
    const createdDocument = {
      documentId: "created-doc",
      name: "Untitled",
      openedAtMs: 2,
      path: "/tmp/Fables/Untitled.fable",
    };
    const onDocumentCreated = vi.fn();
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
    createUntitledDocumentInDirectory.mockResolvedValue(createdDocument);

    await act(async () => {
      root.render(
        <DocumentWorkspace
          document={snapshot.summary}
          onDocumentCreated={onDocumentCreated}
        />,
      );
    });

    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(createUntitledDocumentInDirectory).toHaveBeenCalledWith("/tmp/Fables");
    expect(onDocumentCreated).toHaveBeenCalledWith(createdDocument);

    await act(async () => {
      root.unmount();
    });
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
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    expect(container.textContent).toContain("FABLEside-story");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
    });

    expect(container.textContent).toContain("Delete Document");
    expect(container.textContent).toContain(
      "Are you sure you want to delete \"side-story\" and all of it's contents?",
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
    expect(container.textContent).not.toContain("Delete Document");

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
    expect(useAppStore.getState().notice?.message).toBe("Deleted \"side-story\".");

    await act(async () => {
      root.unmount();
    });
  });

  it("closes the workspace after deleting the current fable document", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      summary: {
        documentId: "doc-1",
        name: "story",
        openedAtMs: 1,
        path: "/tmp/Fables/story.fable",
      },
    };
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

    expect(container.textContent).toContain("Delete Document");

    await act(async () => {
      (
        container.querySelector('[data-testid="confirm-delete-document"]') as HTMLButtonElement | null
      )?.click();
    });

    expect(deleteFableDocument).toHaveBeenCalledWith(snapshot.summary.path);
    expect(onDocumentDeleted).toHaveBeenCalledWith(snapshot.summary.path);

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

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).toContain("FOLDERRobotics");
    expect(container.textContent).toContain("FABLERobotics");
    expect(container.textContent).toContain("FABLEScratchpad");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).toContain("FOLDERRobotics");
    expect(container.textContent).toContain("FABLERobotics");
    expect(container.textContent).toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(container.textContent).not.toContain("FOLDERFrontier");
    expect(container.textContent).toContain("FOLDERRobotics");
    expect(container.textContent).toContain("FABLERobotics");
    expect(container.textContent).toContain("FABLEScratchpad");
    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("balances active card padding around a new empty heading card", async () => {
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

    expect(activeShell?.style.paddingTop).toBe("33px");
    expect(activeShell?.style.paddingBottom).toBe("33px");

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
    expect(navigationShell?.style.minHeight).toBe("1200px");
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
    expect(selectedOverviewCard?.dataset.parentCardLabel).toBe("A01");
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
