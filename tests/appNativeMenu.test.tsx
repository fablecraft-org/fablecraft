import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { useAppStore } from "../src/state/appStore";
import { useDocumentStore } from "../src/state/documentStore";
import { useInteractionStore } from "../src/state/interactionStore";
import { useSettingsStore } from "../src/state/settingsStore";
import { contentJsonForPlainText } from "../src/domain/document/content";
import {
  FRONTEND_MENU_ACTION_EVENT,
  NATIVE_MENU_ACTION_EVENT,
  type NativeMenuAction,
} from "../src/lib/nativeMenu";
import { OPEN_DOCUMENTS_EVENT } from "../src/lib/openDocuments";
import { rememberLastDocumentPath, readRecentDocumentPaths } from "../src/storage/lastDocument";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const mocks = vi.hoisted(() => ({
  existingDocumentPaths: vi.fn(),
  enableClaudeDesktopIntegration: vi.fn(),
  enableCodexIntegration: vi.fn(),
  forceSaveCurrentDocument: vi.fn(),
  listen: vi.fn(),
  loadLocalIntegrationStatuses: vi.fn(),
  openDocumentAtPath: vi.fn(),
  promptForConvertedCardDocument: vi.fn(),
  promptForNewDocument: vi.fn(),
  promptForOpenDocument: vi.fn(),
  saveDocumentSnapshotAtPath: vi.fn(),
  unlisten: vi.fn(),
}));

let nativeMenuCallback:
  | ((event: { payload: { action: NativeMenuAction } }) => void)
  | null = null;
let nativeOpenDocumentCallback:
  | ((event: { payload: { paths: string[] } }) => void)
  | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: (command: string, args: { paths: string[] }) =>
    command === "existing_document_paths" ? mocks.existingDocumentPaths(args.paths) : Promise.resolve([]),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../src/app/documentActions", () => ({
  promptForConvertedCardDocument: (defaultPath?: string) =>
    mocks.promptForConvertedCardDocument(defaultPath),
  promptForNewDocument: () => mocks.promptForNewDocument(),
  promptForOpenDocument: () => mocks.promptForOpenDocument(),
}));

vi.mock("../src/storage/integrations", () => ({
  enableClaudeDesktopIntegration: () => mocks.enableClaudeDesktopIntegration(),
  enableCodexIntegration: () => mocks.enableCodexIntegration(),
  loadLocalIntegrationStatuses: () => mocks.loadLocalIntegrationStatuses(),
}));

vi.mock("../src/storage/forceSave", () => ({
  forceSaveCurrentDocument: () => mocks.forceSaveCurrentDocument(),
}));

vi.mock("../src/storage/documents", () => ({
  openDocumentAtPath: (path: string) => mocks.openDocumentAtPath(path),
}));

vi.mock("../src/storage/documentSnapshots", () => ({
  saveDocumentSnapshotAtPath: (...args: unknown[]) =>
    mocks.saveDocumentSnapshotAtPath(...args),
}));

vi.mock("../src/components/DocumentWorkspace", () => ({
  DocumentWorkspace: ({ onDocumentDeleted, onDocumentCreated }: {
    onDocumentDeleted: (path: string) => void;
    onDocumentCreated: (document: ReturnType<typeof makeDocumentSnapshot>["summary"]) => void;
  }) => (
    <div data-testid="document-workspace">
      <button data-testid="trash-current" onClick={() => onDocumentDeleted(useAppStore.getState().activeDocument!.path)} />
      <button data-testid="trash-other" onClick={() => onDocumentDeleted("/tmp/other.fable")} />
      <button data-testid="create-in-directory" onClick={() => onDocumentCreated({
        documentId: "new-doc", name: "Untitled", openedAtMs: 2, path: "/tmp/Untitled.fable",
      })} />
    </div>
  ),
}));

vi.mock("../src/components/FeedbackDialog", () => ({
  FeedbackDialog: () => <div />,
}));

vi.mock("../src/components/HelpSheet", () => ({
  HelpSheet: () => <div />,
}));

vi.mock("../src/components/SearchOverlay", () => ({
  SearchOverlay: () => <div />,
}));

vi.mock("../src/components/SettingsDialog", () => ({
  SettingsDialog: () => <div />,
}));

function dispatchNativeMenuAction(action: NativeMenuAction) {
  nativeMenuCallback?.({ payload: { action } });
}

function dispatchNativeOpenDocuments(paths: string[]) {
  nativeOpenDocumentCallback?.({ payload: { paths } });
}

function resetAppStore() {
  useAppStore.setState({
    activeDocument: null,
    mode: "navigation",
    notice: null,
    screen: "startup",
  });
}

describe("App native menu handling", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.existingDocumentPaths.mockReset().mockImplementation((paths: string[]) => Promise.resolve(paths));
    nativeMenuCallback = null;
    nativeOpenDocumentCallback = null;
    mocks.enableClaudeDesktopIntegration.mockReset();
    mocks.enableCodexIntegration.mockReset();
    mocks.forceSaveCurrentDocument.mockReset();
    mocks.listen.mockReset();
    mocks.loadLocalIntegrationStatuses.mockReset();
    mocks.openDocumentAtPath.mockReset();
    mocks.promptForConvertedCardDocument.mockReset();
    mocks.promptForNewDocument.mockReset();
    mocks.promptForOpenDocument.mockReset();
    mocks.saveDocumentSnapshotAtPath.mockReset();
    mocks.unlisten.mockReset();
    mocks.listen.mockImplementation(
      async (
        eventName: string,
        callback:
          | ((event: { payload: { action: NativeMenuAction } }) => void)
          | ((event: { payload: { paths: string[] } }) => void),
      ) => {
        if (eventName === NATIVE_MENU_ACTION_EVENT) {
          nativeMenuCallback = callback as (event: {
            payload: { action: NativeMenuAction };
          }) => void;
        }

        if (eventName === OPEN_DOCUMENTS_EVENT) {
          nativeOpenDocumentCallback = callback as (event: {
            payload: { paths: string[] };
          }) => void;
        }

        return mocks.unlisten;
      },
    );
    mocks.loadLocalIntegrationStatuses.mockResolvedValue({
      claudeDesktop: {
        binaryExists: false,
        binaryPath: null,
        configPath: "",
        enabled: false,
      },
      codex: {
        binaryExists: false,
        binaryPath: null,
        configPath: "",
        enabled: false,
      },
    });
    mocks.forceSaveCurrentDocument.mockResolvedValue(null);
    mocks.openDocumentAtPath.mockImplementation((path: string) =>
      Promise.resolve({
        documentId: "recent-doc",
        name: "Recent Story",
        openedAtMs: 3,
        path,
      }),
    );
    mocks.saveDocumentSnapshotAtPath.mockResolvedValue({
      revisionId: "revision-1",
      savedAtMs: 10,
    });
    resetAppStore();
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
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    document.body.innerHTML = "";
    resetAppStore();
    useDocumentStore.setState({
      snapshot: null,
    });
    useInteractionStore.setState({
      activeCardId: null,
    });
  });

  it.each([true, false])("cleans up a trashed document (active=%s)", async (active) => {
    window.localStorage.clear();
    const snapshot = makeDocumentSnapshot();
    rememberLastDocumentPath("/tmp/other.fable");
    rememberLastDocumentPath(snapshot.summary.path);
    mocks.promptForOpenDocument.mockResolvedValue(snapshot.summary);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<App />); });
    await act(async () => { dispatchNativeMenuAction("open-document"); });
    await act(async () => {
      useDocumentStore.getState().hydrateSnapshot(snapshot);
      useDocumentStore.getState().applyNavigationChange((value) => value);
      useInteractionStore.getState().setActiveCardId("card-root");
    });
    const storedSnapshot = useDocumentStore.getState().snapshot;
    await act(async () => {
      (container.querySelector(active ? '[data-testid="trash-current"]' : '[data-testid="trash-other"]') as HTMLButtonElement).click();
    });
    expect(readRecentDocumentPaths()).not.toContain(active ? snapshot.summary.path : "/tmp/other.fable");
    expect(useAppStore.getState().activeDocument).toEqual(active ? null : snapshot.summary);
    expect(useDocumentStore.getState().snapshot).toEqual(active ? null : storedSnapshot);
    if (active) {
      expect(useDocumentStore.getState().navigationPast).toEqual([]);
      expect(useDocumentStore.getState().dirty).toBe(false);
      expect(useInteractionStore.getState().activeCardId).toBeNull();
    }
    await act(async () => { root.unmount(); });
  });

  it("keeps the current document, snapshot, and recent history when a directory file is created", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<App />); });
    const snapshot = makeDocumentSnapshot();
    await act(async () => {
      useAppStore.getState().setDocument(snapshot.summary);
      useAppStore.getState().setMode("navigation");
      useDocumentStore.getState().hydrateSnapshot(snapshot);
    });
    const currentSnapshot = useDocumentStore.getState().snapshot;
    const recentPaths = readRecentDocumentPaths();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="create-in-directory"]')!.click();
    });
    expect(useAppStore.getState().activeDocument).toEqual(snapshot.summary);
    expect(useDocumentStore.getState().snapshot).toEqual(currentSnapshot);
    expect(useAppStore.getState().mode).toBe("navigation");
    expect(readRecentDocumentPaths()).toEqual(recentPaths);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("keeps one native menu listener after opening a document", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    mocks.promptForOpenDocument.mockResolvedValue({
      documentId: "doc-1",
      name: "Story",
      openedAtMs: 1,
      path: "/tmp/story.fable",
    });

    await act(async () => {
      root.render(<App />);
    });

    expect(mocks.listen).toHaveBeenCalledTimes(2);

    await act(async () => {
      dispatchNativeMenuAction("open-document");
    });

    expect(
      mocks.forceSaveCurrentDocument.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.promptForOpenDocument.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().screen).toBe("workspace");
    expect(mocks.listen).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("force saves before creating a new document", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    mocks.promptForNewDocument.mockResolvedValue({
      documentId: "doc-2",
      name: "New Story",
      openedAtMs: 2,
      path: "/tmp/new-story.fable",
    });

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      dispatchNativeMenuAction("new-document");
    });

    expect(
      mocks.forceSaveCurrentDocument.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.promptForNewDocument.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().activeDocument?.documentId).toBe("doc-2");

    await act(async () => {
      root.unmount();
    });
  });

  it("converts the selected card subtree into a new document from the command palette", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: makeDocumentSnapshot().contents.map((content) =>
        content.cardId === "card-a"
          ? { ...content, contentJson: contentJsonForPlainText("Extracted scene") }
          : content,
      ),
    };

    mocks.promptForConvertedCardDocument.mockResolvedValue({
      documentId: "doc-2",
      name: "Extracted",
      openedAtMs: 2,
      path: "/tmp/extracted.fable",
    });

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useAppStore.setState({
        activeDocument: snapshot.summary,
        mode: "navigation",
        notice: null,
        screen: "workspace",
      });
      useDocumentStore.getState().hydrateSnapshot(snapshot);
      useInteractionStore.setState({
        activeCardId: "card-a",
      });
    });

    await act(async () => {
      dispatchNativeMenuAction("command-palette");
    });

    const commandInput = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        commandInput,
        "convert",
      );
      commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      const convertButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Convert Card to Document",
      );
      convertButton?.click();
    });

    expect(mocks.promptForConvertedCardDocument).toHaveBeenCalledWith(
      "Extracted scene.fable",
    );
    expect(mocks.saveDocumentSnapshotAtPath).toHaveBeenCalledTimes(2);
    expect(mocks.saveDocumentSnapshotAtPath.mock.calls[0][0]).toBe(
      "/tmp/extracted.fable",
    );
    expect(mocks.saveDocumentSnapshotAtPath.mock.calls[0][1].documentId).toBe(
      "doc-2",
    );
    expect(mocks.saveDocumentSnapshotAtPath.mock.calls[0][1].cards.map(
      (card: { id: string; parentId: string | null }) => [card.id, card.parentId],
    )).toEqual([["card-a", null]]);
    expect(mocks.saveDocumentSnapshotAtPath.mock.calls[1][0]).toBe(
      "/tmp/story.fable",
    );
    expect(mocks.saveDocumentSnapshotAtPath.mock.calls[1][1].cards.some(
      (card: { id: string }) => card.id === "card-a",
    )).toBe(false);
    expect(useAppStore.getState().activeDocument?.documentId).toBe("doc-2");
    expect(useDocumentStore.getState().snapshot?.summary.documentId).toBe("doc-2");
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens a .fable document from a native open-file event", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      dispatchNativeOpenDocuments(["/tmp/notes.txt", "/tmp/finder-story.fable"]);
    });

    expect(
      mocks.forceSaveCurrentDocument.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.openDocumentAtPath.mock.invocationCallOrder[0]);
    expect(mocks.openDocumentAtPath).toHaveBeenCalledWith("/tmp/finder-story.fable");
    expect(useAppStore.getState().activeDocument?.path).toBe("/tmp/finder-story.fable");

    await act(async () => {
      root.unmount();
    });
  });

  it("remembers beta notice dismissal across fresh app mounts and preference resets", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("This is a beta version of Fablecraft.");
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();

    await act(async () => {
      dismiss!.click();
    });

    expect(container.textContent).not.toContain("This is a beta version of Fablecraft.");

    await act(async () => {
      root.unmount();
    });
    useSettingsStore.getState().resetPreferences();
    root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).not.toContain("This is a beta version of Fablecraft.");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders notices as inverse-color cards in the top right", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useAppStore.setState({
      activeDocument: null,
      mode: "navigation",
      notice: {
        message: "Saved the document.",
        tone: "info",
      },
      screen: "startup",
    });

    await act(async () => {
      root.render(<App />);
    });

    const notice = container.querySelector('[role="status"]');

    expect(notice?.textContent).toBe("Saved the document.");
    expect(notice?.className).toContain("right-4");
    expect(notice?.className).toContain("top-4");
    expect(notice?.className).toContain("bg-[var(--fc-color-notice-surface)]");
    expect(notice?.className).toContain("text-[var(--fc-color-notice-text)]");
    expect(notice?.className).not.toContain("rounded");

    await act(async () => {
      root.unmount();
    });
  });

  it("force saves when Cmd+S is pressed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useAppStore.setState({
        activeDocument: {
          documentId: "doc-1",
          name: "Story",
          openedAtMs: 1,
          path: "/tmp/story.fable",
        },
        mode: "navigation",
        notice: null,
        screen: "workspace",
      });
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "s",
          metaKey: true,
        }),
      );
    });

    expect(mocks.forceSaveCurrentDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores duplicate open-document events while the picker is pending", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolveOpenDocument:
      | ((document: {
          documentId: string;
          name: string;
          openedAtMs: number;
          path: string;
        }) => void)
      | null = null;

    mocks.promptForOpenDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpenDocument = resolve;
        }),
    );

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      dispatchNativeMenuAction("open-document");
      dispatchNativeMenuAction("open-document");
    });

    expect(mocks.promptForOpenDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpenDocument?.({
        documentId: "doc-1",
        name: "Story",
        openedAtMs: 1,
        path: "/tmp/story.fable",
      });
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("hides recent paths until checked and rechecks before opening the recent panel", async () => {
    rememberLastDocumentPath("/tmp/removed.fable");
    rememberLastDocumentPath("/tmp/present.fable");
    let finishCheck!: (paths: string[]) => void;
    mocks.existingDocumentPaths.mockImplementationOnce(() => new Promise<string[]>((resolve) => {
      finishCheck = resolve;
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<App />); });
    expect(container.textContent).not.toContain("Open Recent");
    await act(async () => { finishCheck(["/tmp/present.fable"]); });
    expect(container.textContent).toContain("Open Recent");
    expect(readRecentDocumentPaths()).toEqual(["/tmp/present.fable"]);

    mocks.existingDocumentPaths.mockResolvedValueOnce([]);
    const openRecent = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Open Recent"),
    )!;
    await act(async () => { openRecent.click(); });
    expect(container.textContent).not.toContain("present");
    expect(readRecentDocumentPaths()).toEqual([]);
    expect(mocks.openDocumentAtPath).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("opens recent documents from the native menu", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    window.localStorage.setItem(
      "fablecraft:recent-document-paths",
      JSON.stringify(["/tmp/novel-draft.fable", "/tmp/essay-plan.fable"]),
    );

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      dispatchNativeMenuAction("open-recent");
    });

    expect(container.textContent).toContain("Open Recent");
    expect(container.textContent).toContain("novel-draft");
    expect(container.textContent).toContain("essay-plan");

    const recentDocument = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("novel-draft"),
    ) as HTMLButtonElement;

    await act(async () => {
      recentDocument.click();
    });

    expect(mocks.openDocumentAtPath).toHaveBeenCalledWith("/tmp/novel-draft.fable");
    expect(useAppStore.getState().activeDocument?.path).toBe("/tmp/novel-draft.fable");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens recent documents from the command palette", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    window.localStorage.setItem(
      "fablecraft:recent-document-paths",
      JSON.stringify(["/tmp/novel-draft.fable", "/tmp/essay-plan.fable"]),
    );

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useAppStore.setState({
        activeDocument: {
          documentId: "doc-1",
          name: "Story",
          openedAtMs: 1,
          path: "/tmp/story.fable",
        },
        mode: "navigation",
        notice: null,
        screen: "workspace",
      });
    });

    await act(async () => {
      dispatchNativeMenuAction("command-palette");
    });

    const commandInput = container.querySelector("input") as HTMLInputElement;

    expect(commandInput.getAttribute("autocomplete")).toBe("off");
    expect(commandInput.getAttribute("autocapitalize")).toBe("none");
    expect(commandInput.getAttribute("autocorrect")).toBe("off");
    expect(commandInput.getAttribute("spellcheck")).toBe("false");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        commandInput,
        "recent",
      );
      commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const openRecentCommand = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Open Recent"),
    ) as HTMLButtonElement;

    await act(async () => {
      openRecentCommand.click();
    });

    expect(container.textContent).toContain("novel-draft");
    expect(container.textContent).toContain("essay-plan");

    await act(async () => {
      root.unmount();
    });
  });

  it("exposes zoom commands from the command palette", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const frontendActions: NativeMenuAction[] = [];
    const handleFrontendAction = (event: Event) => {
      const action = (event as CustomEvent<{ action: NativeMenuAction }>).detail.action;
      frontendActions.push(action);
    };

    window.addEventListener(FRONTEND_MENU_ACTION_EVENT, handleFrontendAction);

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      useAppStore.setState({
        activeDocument: {
          documentId: "doc-1",
          name: "Story",
          openedAtMs: 1,
          path: "/tmp/story.fable",
        },
        mode: "navigation",
        notice: null,
        screen: "workspace",
      });
    });

    await act(async () => {
      dispatchNativeMenuAction("command-palette");
    });

    const commandInput = container.querySelector("input") as HTMLInputElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        commandInput,
        "zoom",
      );
      commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("Zoomed In");
    expect(container.textContent).toContain("Zoomed Out");

    const zoomedOutCommand = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Zoomed Out"),
    ) as HTMLButtonElement;

    await act(async () => {
      zoomedOutCommand.click();
    });

    expect(frontendActions).toContain("zoom-out");
    expect(useAppStore.getState().mode).toBe("navigation");

    window.removeEventListener(FRONTEND_MENU_ACTION_EVENT, handleFrontendAction);

    await act(async () => {
      root.unmount();
    });
  });
});
