import { manuscriptCommands } from "../components/manuscriptCommands";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  promptForNewDocument,
  promptForNewDocumentFromTree,
  promptForOpenDocument,
} from "./documentActions";
import { exportCurrentLevelToFile, importMarkdownDocument } from "./importExportActions";
import { AppUpdateDialog } from "../components/AppUpdateDialog";
import { CommandPalette, type CommandPaletteItem } from "../components/CommandPalette";
import { DocumentHistory } from "../components/DocumentHistory";
import type { WorkspacePane } from "../domain/document/manuscriptLayout";
import { historyLayoutTokens } from "../styles/tokens";
import { DocumentWorkspace, type HistoryEditTarget, type WorkspaceViewMode } from "../components/DocumentWorkspace";
import { FeedbackDialog, type FeedbackDialogMode } from "../components/FeedbackDialog";
import { HelpSheet } from "../components/HelpSheet";
import { RecentDocumentsOverlay } from "../components/RecentDocumentsOverlay";
import { SearchOverlay } from "../components/SearchOverlay";
import { SettingsDialog } from "../components/SettingsDialog";
import { StartupPanel } from "../components/StartupPanel";
import {
  createDocumentFromCardSubtree,
  defaultConvertedDocumentName,
  removeConvertedCardFromSource,
} from "../domain/document/cardDocumentConversion";
import { toEditableDocumentSnapshot } from "../domain/document/serialization";
import { mergeCardWithNextSibling, mergeCardWithPreviousSibling } from "../domain/document/tree";
import {
  dispatchNativeMenuAction,
  listenForNativeMenuActions,
  updateWorkspaceMenu,
  type NativeMenuAction,
} from "../lib/nativeMenu";
import { isMacOs, syncNativeWindowAppearance } from "../lib/nativeWindowAppearance";
import {
  listenForNativeOpenDocuments,
  takePendingOpenDocumentPaths,
} from "../lib/openDocuments";
import {
  clearLastDocumentPath,
  forgetRecentDocumentPath,
  rememberLastDocumentPath,
  replaceRecentDocumentPath,
} from "../storage/lastDocument";
import { refreshRecentDocumentPaths } from "../storage/recentDocuments";
import { openDocumentAtPath } from "../storage/documents";
import { isBetaNoticeDismissed, rememberBetaNoticeDismissal } from "../storage/betaNotice";
import { saveDocumentSnapshotAtPath } from "../storage/documentSnapshots";
import { forceSaveCurrentDocument } from "../storage/forceSave";
import { preloadHistoryFirstPage, warmDocumentHistory, type HistoryFirstPage } from "../storage/documentHistory";
import {
  enableClaudeDesktopIntegration,
  enableCodexIntegration,
  loadLocalIntegrationStatuses,
  type LocalIntegrationStatuses,
} from "../storage/integrations";
import {
  checkForAppUpdate,
  installAppUpdate,
  type AppUpdate,
  type AppUpdateProgress,
} from "../storage/appUpdater";
import { useAppStore, type AppMode } from "../state/appStore";
import { useDocumentStore } from "../state/documentStore";
import { useInteractionStore } from "../state/interactionStore";
import { useSettingsStore } from "../state/settingsStore";

type OverlayReturnMode = Exclude<AppMode, "command" | "search">;
type HelpSheetMode = "commands" | "getting-started" | "shortcuts";
type AppUpdateDialogStatus = "available" | "downloading" | "installing" | "error";

function noticeMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

const defaultIntegrationStatuses: LocalIntegrationStatuses = {
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
};

export function App() {
  const [overlayReturnMode, setOverlayReturnMode] =
    useState<OverlayReturnMode>("navigation");
  const [integrationStatuses, setIntegrationStatuses] =
    useState<LocalIntegrationStatuses>(defaultIntegrationStatuses);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [helpSheetMode, setHelpSheetMode] = useState<HelpSheetMode | null>(null);
  const [feedbackDialogMode, setFeedbackDialogMode] = useState<FeedbackDialogMode | null>(null);
  const [isRecentDocumentsOpen, setRecentDocumentsOpen] = useState(false);
  const [appUpdateDialogStatus, setAppUpdateDialogStatus] =
    useState<AppUpdateDialogStatus | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null);
  const [appUpdateErrorMessage, setAppUpdateErrorMessage] = useState<string | null>(null);
  const [appUpdateProgress, setAppUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [showBetaBar, setShowBetaBar] = useState(() => !isBetaNoticeDismissed());
  const [recentDocumentPaths, setRecentDocumentPaths] = useState<string[]>([]);
  const [history, setHistory] = useState<{
    session: number;
    path: string;
    pane: WorkspacePane;
    livePane: WorkspacePane;
    surfaceVisible: boolean;
  } | null>(null);
  const [treeViewMode, setTreeViewMode] = useState<WorkspaceViewMode>("normal");
  const [historyPaneRequest, setHistoryPaneRequest] = useState<(HistoryEditTarget & { session: number; startEditing?: boolean; keepEditing?: boolean }) | null>(null);
  const [historyNarrow, setHistoryNarrow] = useState(() => window.innerWidth < historyLayoutTokens.narrowWidth);
  const historyOpening = useRef(false);
  const historicalPreview = useDocumentStore((state) => state.historicalPreview);
  const documentSession = useDocumentStore((state) => state.session);
  const nativeMenuActionHandlerRef = useRef<(action: NativeMenuAction) => void>(() => {});
  const openDocumentPathHandlerRef = useRef<(path: string) => void>(() => {});
  const openDocumentPromptInFlightRef = useRef(false);
  const updateCheckInFlightRef = useRef(false);
  const startupUpdateCheckStartedRef = useRef(false);
  const activeDocument = useAppStore((state) => state.activeDocument);
  const mode = useAppStore((state) => state.mode);
  const notice = useAppStore((state) => state.notice);
  const screen = useAppStore((state) => state.screen);
  const setDocument = useAppStore((state) => state.setDocument);
  const setMode = useAppStore((state) => state.setMode);
  const setNotice = useAppStore((state) => state.setNotice);
  const setScreen = useAppStore((state) => state.setScreen);
  const theme = useSettingsStore((state) => state.preferences.theme);
  const snapshot = useDocumentStore((state) => state.snapshot);
  const applyNavigationChange = useDocumentStore(
    (state) => state.applyNavigationChange,
  );
  const hydrateSnapshot = useDocumentStore((state) => state.hydrateSnapshot);
  const markSaved = useDocumentStore((state) => state.markSaved);
  const activeCardId = useInteractionStore((state) => state.activeCardId);
  const setActiveCardId = useInteractionStore((state) => state.setActiveCardId);
  const activeSnapshot =
    activeDocument && snapshot?.summary.documentId === activeDocument.documentId
      ? snapshot
      : null;
  const firstHistoryPage = useMemo<HistoryFirstPage>(() => ({ page: null, pending: null }),
    [documentSession, activeDocument?.path, activeDocument?.documentId]);
  const historyHeadId = activeSnapshot?.revisions[0]?.id;
  const openHistory = history?.session === documentSession && history.path === activeDocument?.path
    ? history : null;
  const historyTimelineOnly = Boolean(openHistory && historyNarrow && !openHistory.surfaceVisible);
  const historyBlocksLive = historicalPreview || historyTimelineOnly;
  const historyShortcutsSuspended = Boolean(isSettingsOpen || helpSheetMode || feedbackDialogMode ||
    isRecentDocumentsOpen || appUpdateDialogStatus || mode === "command" || mode === "search");

  useEffect(() => {
    const resize = () => setHistoryNarrow(window.innerWidth < historyLayoutTokens.narrowWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (history && !openHistory) {
      setHistory(null);
      setHistoryPaneRequest(null);
      useDocumentStore.getState().setHistoricalPreview(false);
    }
  }, [history, openHistory]);

  async function toggleHistory() {
    if (!activeDocument || !activeSnapshot || historyOpening.current ||
      useInteractionStore.getState().workspaceDialog ||
      document.querySelector("[data-editor-composing=true]")) return;
    if (openHistory) {
      closeHistory();
      return;
    }
    const pane = useInteractionStore.getState().workspacePane;
    const path = activeDocument.path;
    const session = useDocumentStore.getState().session;
    historyOpening.current = true;
    useDocumentStore.getState().setHistoricalPreview(true);
    try {
      await forceSaveCurrentDocument();
      const state = useDocumentStore.getState();
      if (state.session !== session || state.snapshot?.summary.path !== path) return;
      setHistoryPaneRequest(null);
      setHistory({ session, path, pane, livePane: pane, surfaceVisible: false });
    } catch (error) {
      if (useDocumentStore.getState().session === session) {
        setNotice({ tone: "error", message: noticeMessage(error, "Fablecraft could not flush pending edits.") });
      }
    } finally {
      historyOpening.current = false;
      if (useDocumentStore.getState().session === session) useDocumentStore.getState().setHistoricalPreview(false);
    }
  }

  function changeHistoryPane(pane: WorkspacePane) {
    setHistory((current) => current ? { ...current, pane } : current);
    if (openHistory?.surfaceVisible && !useDocumentStore.getState().historicalPreview) {
      setHistoryPaneRequest({ pane, session: documentSession });
    }
  }

  function showHistorySurface(visible: boolean) {
    setHistory((current) => current ? { ...current, surfaceVisible: visible } : current);
    if (visible && openHistory && !useDocumentStore.getState().historicalPreview) {
      setHistoryPaneRequest({ pane: openHistory.pane, session: documentSession });
    }
  }

  function closeHistory(editTarget?: HistoryEditTarget) {
    if (!openHistory || (useDocumentStore.getState().restoringHistory && !editTarget)) return;
    useDocumentStore.getState().setHistoricalPreview(false);
    setHistoryPaneRequest(editTarget
      ? { ...editTarget, session: documentSession, startEditing: true }
      : { pane: openHistory.livePane, session: documentSession });
    setHistory(null);
  }

  useEffect(() => {
    if (!activeDocument || !isTauri()) return;
    const document = activeDocument;
    const prepare = () => void warmDocumentHistory(document).catch(console.error);
    prepare();
    const timer = window.setInterval(prepare, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [activeDocument?.documentId, activeDocument?.path]);

  useEffect(() => {
    if (openHistory || !activeDocument || !historyHeadId || firstHistoryPage.page?.headId === historyHeadId) return;
    const document = activeDocument;
    let stopped = false;
    let timer: number | undefined;
    async function preload() {
      try {
        const page = await preloadHistoryFirstPage(document, firstHistoryPage);
        if (!stopped && page.preparing) timer = window.setTimeout(() => void preload(), 250);
      } catch {
        // Opening History can retry and display an error if the read still fails.
      }
    }
    void preload();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [firstHistoryPage, historyHeadId, Boolean(openHistory)]);

  useEffect(() => {
    if (!openHistory) return;
    const history = openHistory;
    function closeForEditing() {
      const state = useDocumentStore.getState();
      if (state.session !== history.session || state.historicalPreview || state.restoringHistory) return;
      setHistoryPaneRequest(history.pane === history.livePane ? null
        : { pane: history.pane, session: history.session, keepEditing: true });
      setHistory(null);
    }
    const unsubscribeMode = useAppStore.subscribe((next, previous) => {
      if (next.mode === "editing" && previous.mode === "navigation") closeForEditing();
    });
    const unsubscribeDocument = useDocumentStore.subscribe((next, previous) => {
      if (next.dirty && next.snapshot !== previous.snapshot) closeForEditing();
    });
    return () => { unsubscribeMode(); unsubscribeDocument(); };
  }, [openHistory]);

  const selectedCard =
    activeSnapshot?.cards.find((card) => card.id === activeCardId) ?? null;
  const selectedSiblingGroup = selectedCard
    ? (activeSnapshot?.cards
        .filter((card) => card.parentId === selectedCard.parentId)
        .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id)) ??
      [])
    : [];
  const selectedSiblingIndex = selectedCard
    ? selectedSiblingGroup.findIndex((card) => card.id === selectedCard.id)
    : -1;
  const canMergeWithAbove = selectedSiblingIndex > 0;
  const canMergeWithBelow =
    selectedSiblingIndex !== -1 &&
    selectedSiblingIndex < selectedSiblingGroup.length - 1;

  async function refreshIntegrationStatuses() {
    try {
      setIntegrationStatuses(await loadLocalIntegrationStatuses());
    } catch (error) {
      console.error(error);
    }
  }

  useEffect(() => {
    void syncNativeWindowAppearance(theme, { restoreFocus: isSettingsOpen });
  }, [isSettingsOpen, theme]);

  useEffect(() => {
    void refreshRecentDocuments();
    setScreen("startup");
  }, [setScreen]);

  useEffect(() => {
    if (screen !== "workspace") {
      return;
    }

    void refreshIntegrationStatuses();
  }, [screen, mode]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(
      () => setNotice(null),
      notice.tone === "error" ? 5200 : 3200,
    );

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notice, setNotice]);

  function restoreOverlayMode() {
    setMode(overlayReturnMode);
    if (useInteractionStore.getState().workspacePane === "manuscript") {
      requestAnimationFrame(() => dispatchNativeMenuAction("restore-manuscript-focus"));
    }
  }

  function closeAuxiliaryOverlays() {
    setSettingsOpen(false);
    setHelpSheetMode(null);
    setFeedbackDialogMode(null);
    setRecentDocumentsOpen(false);
  }

  function closeAppUpdateDialog() {
    if (appUpdateDialogStatus === "downloading" || appUpdateDialogStatus === "installing") {
      return;
    }

    void appUpdate?.update.close();
    setAppUpdate(null);
    setAppUpdateDialogStatus(null);
    setAppUpdateErrorMessage(null);
    setAppUpdateProgress(null);
  }

  function openFeedbackDialog(feedbackMode: FeedbackDialogMode) {
    if (screen !== "workspace") {
      return;
    }

    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");
    setMode("navigation");
    setFeedbackDialogMode(feedbackMode);
  }

  function openCommandPalette() {
    if (screen !== "workspace") {
      return;
    }

    if (mode === "command") {
      restoreOverlayMode();
      return;
    }

    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");
    setMode("command");
  }

  function openSearchOverlay() {
    if (screen !== "workspace" || !activeSnapshot) {
      return;
    }

    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");
    setMode("search");
  }

  function openHelpSheet(modeToOpen: HelpSheetMode) {
    if (screen !== "workspace") {
      return;
    }

    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");
    setMode("navigation");
    setHelpSheetMode(modeToOpen);
  }

  function openSettingsDialog() {
    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");
    setMode("navigation");
    setSettingsOpen(true);
  }

  async function refreshRecentDocuments() {
    setRecentDocumentPaths([]);
    try {
      const paths = await refreshRecentDocumentPaths();
      setRecentDocumentPaths(paths);
      return paths;
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not check recent documents."),
      });
      return null;
    }
  }

  async function openRecentDocumentsOverlay() {
    const nextRecentDocumentPaths = await refreshRecentDocuments();
    if (!nextRecentDocumentPaths) return;

    if (nextRecentDocumentPaths.length === 0) {
      setNotice({
        tone: "info",
        message: "No recent documents yet.",
      });
      return;
    }

    closeAuxiliaryOverlays();
    setOverlayReturnMode(mode === "editing" ? "editing" : "navigation");

    if (screen === "workspace") {
      setMode("navigation");
    }

    setRecentDocumentsOpen(true);
  }

  function closeRecentDocumentsOverlay() {
    setRecentDocumentsOpen(false);

    if (screen === "workspace") {
      restoreOverlayMode();
    }
  }

  async function handleForceSave() {
    try {
      await forceSaveCurrentDocument();
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not save that document."),
      });
    }
  }

  async function handleCheckForUpdates(options: { manual: boolean }) {
    if (
      updateCheckInFlightRef.current ||
      appUpdateDialogStatus === "downloading" ||
      appUpdateDialogStatus === "installing"
    ) {
      return;
    }

    updateCheckInFlightRef.current = true;

    if (options.manual) {
      setNotice({
        tone: "info",
        message: "Checking for updates...",
      });
    }

    try {
      const nextUpdate = await checkForAppUpdate();

      if (!nextUpdate) {
        if (options.manual) {
          setNotice({
            tone: "info",
            message: "Fablecraft is up to date.",
          });
        }

        return;
      }

      closeAuxiliaryOverlays();
      setNotice(null);
      setAppUpdate(nextUpdate);
      setAppUpdateProgress(null);
      setAppUpdateErrorMessage(null);
      setAppUpdateDialogStatus("available");
    } catch (error) {
      const message = noticeMessage(error, "Fablecraft could not check for updates.");

      if (options.manual) {
        setNotice({
          tone: "error",
          message,
        });
      } else {
        console.warn(message, error);
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }

  async function handleInstallAppUpdate() {
    if (!appUpdate || appUpdateDialogStatus !== "available") {
      return;
    }

    setAppUpdateDialogStatus("downloading");
    setAppUpdateErrorMessage(null);
    setAppUpdateProgress({
      contentLength: null,
      downloaded: 0,
      percent: null,
    });

    try {
      await forceSaveCurrentDocument();
      await installAppUpdate(appUpdate, (progress) => {
        setAppUpdateProgress(progress);

        if (progress.percent === 100) {
          setAppUpdateDialogStatus("installing");
        }
      });
    } catch (error) {
      setAppUpdateErrorMessage(
        noticeMessage(error, "Fablecraft could not install the update."),
      );
      setAppUpdateDialogStatus("error");
    }
  }

  useEffect(() => {
    if (startupUpdateCheckStartedRef.current) {
      return;
    }

    startupUpdateCheckStartedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void handleCheckForUpdates({ manual: false });
    }, 1500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        (
          isSettingsOpen ||
          helpSheetMode ||
          feedbackDialogMode ||
          isRecentDocumentsOpen ||
          appUpdateDialogStatus
        )
      ) {
        event.preventDefault();
        if (appUpdateDialogStatus) {
          closeAppUpdateDialog();
        } else if (isRecentDocumentsOpen) {
          closeRecentDocumentsOverlay();
        } else {
          closeAuxiliaryOverlays();
          restoreOverlayMode();
        }
        return;
      }

      // Desktop dispatches this accelerator through the native Tools menu.
      if (!isTauri() && activeSnapshot && screen === "workspace" && !historyShortcutsSuspended &&
        !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 &&
        !event.altKey && event.key.toLowerCase() === "h" &&
        (isMacOs() ? event.metaKey && event.shiftKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey && !event.shiftKey)) {
        event.preventDefault();
        if (!event.repeat) void toggleHistory();
        return;
      }
      if (historyBlocksLive || (event.target instanceof Element && event.target.closest(".fc-history-timeline"))) return;
      if (screen !== "workspace" || event.defaultPrevented || event.isComposing ||
        event.keyCode === 229 || useInteractionStore.getState().workspaceDialog ||
        isSettingsOpen || helpSheetMode || feedbackDialogMode || isRecentDocumentsOpen || appUpdateDialogStatus) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommandPalette();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (useInteractionStore.getState().workspacePane === "manuscript" && mode !== "command" && mode !== "search") {
          dispatchNativeMenuAction("search");
        } else openSearchOverlay();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleForceSave();
        return;
      }

    }

    window.addEventListener("keydown", handleGlobalKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [
    activeSnapshot,
    historyBlocksLive,
    historyShortcutsSuspended,
    toggleHistory,
    feedbackDialogMode,
    appUpdateDialogStatus,
    helpSheetMode,
    isRecentDocumentsOpen,
    isSettingsOpen,
    mode,
    openCommandPalette,
    openSearchOverlay,
    overlayReturnMode,
    screen,
  ]);

  async function handleNewDocument() {
    try {
      await forceSaveCurrentDocument();
      const document = await promptForNewDocument();

      if (!document) {
        return;
      }

      setRecentDocumentPaths(rememberLastDocumentPath(document.path));
      setDocument(document);
      setMode("editing");
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not create that document."),
      });
    }
  }

  async function handleOpenDocument() {
    if (openDocumentPromptInFlightRef.current) {
      return;
    }

    openDocumentPromptInFlightRef.current = true;

    try {
      await forceSaveCurrentDocument();
      const document = await promptForOpenDocument();

      if (!document) {
        return;
      }

      setRecentDocumentPaths(rememberLastDocumentPath(document.path));
      setDocument(document);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not open that document."),
      });
    } finally {
      openDocumentPromptInFlightRef.current = false;
    }
  }

  async function handleNewDocumentFromTree() {
    if (!activeSnapshot || !activeDocument || !activeCardId || !selectedCard) {
      return;
    }

    const sourcePath = activeDocument.path;
    let targetCreated = false;

    try {
      await forceSaveCurrentDocument();
      const sourceSnapshot = useDocumentStore.getState().snapshot;
      if (!sourceSnapshot || sourceSnapshot.summary.path !== sourcePath) return;
      const targetDocument = await promptForNewDocumentFromTree(
        defaultConvertedDocumentName(sourceSnapshot, activeCardId),
      );

      if (!targetDocument) {
        return;
      }
      targetCreated = true;

      const targetSnapshot = createDocumentFromCardSubtree(
        sourceSnapshot,
        activeCardId,
        targetDocument,
      );
      const sourceSnapshotAfterConversion = removeConvertedCardFromSource(
        sourceSnapshot,
        activeCardId,
      );

      const targetSaveResult = await saveDocumentSnapshotAtPath(
        targetDocument.path,
        toEditableDocumentSnapshot(targetSnapshot),
      );
      await saveDocumentSnapshotAtPath(
        sourcePath,
        toEditableDocumentSnapshot(sourceSnapshotAfterConversion),
      );

      setRecentDocumentPaths(rememberLastDocumentPath(targetDocument.path));
      setDocument(targetDocument);
      hydrateSnapshot(targetSnapshot);
      markSaved(targetSaveResult, targetDocument.documentId);
      setActiveCardId(activeCardId);
      setMode("navigation");
      setNotice({
        tone: "info",
        message: `Moved tree to "${targetDocument.name}".`,
      });
    } catch (error) {
      if (targetCreated && useAppStore.getState().activeDocument?.path === sourcePath) {
        await openDocumentAtPath(sourcePath).catch(console.error);
      }
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not move that tree into a new document."),
      });
    }
  }

  async function handleOpenRecentDocument(path: string) {
    if (!path) {
      return;
    }

    setRecentDocumentsOpen(false);

    try {
      await forceSaveCurrentDocument();
      const document = await openDocumentAtPath(path);
      setRecentDocumentPaths(rememberLastDocumentPath(document.path));
      setDocument(document);
      setNotice(null);
    } catch (error) {
      const nextRecentDocumentPaths = forgetRecentDocumentPath(path);
      setRecentDocumentPaths(nextRecentDocumentPaths);
      if (nextRecentDocumentPaths.length === 0) {
        clearLastDocumentPath();
      }
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not reopen that recent document."),
      });
      setScreen("startup");
    }
  }

  async function handleOpenDocumentPath(path: string) {
    try {
      await forceSaveCurrentDocument();
      const document = await openDocumentAtPath(path);
      setRecentDocumentPaths(rememberLastDocumentPath(document.path));
      setDocument(document);
      setMode("navigation");
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not open that document."),
      });
    }
  }

  openDocumentPathHandlerRef.current = (path) => {
    void handleOpenDocumentPath(path);
  };

  function handleWorkspaceDocumentCreated(document: NonNullable<typeof activeDocument>) {
    setNotice({
      tone: "info",
      message: `Created "${document.name}".`,
    });
  }

  function handleWorkspaceDocumentRenamed(
    document: NonNullable<typeof activeDocument>,
    previousPath: string,
  ) {
    setRecentDocumentPaths(replaceRecentDocumentPath(previousPath, document.path));
    setDocument(document);
    setNotice({
      tone: "info",
      message: `Renamed document to "${document.name}".`,
    });
  }

  function handleWorkspaceDocumentDeleted(path: string) {
    const nextRecentDocumentPaths = forgetRecentDocumentPath(path);
    setRecentDocumentPaths(nextRecentDocumentPaths);
    if (nextRecentDocumentPaths.length === 0) {
      clearLastDocumentPath();
    }
    if (useAppStore.getState().activeDocument?.path === path) {
      useDocumentStore.getState().clearDocument();
      useInteractionStore.getState().setActiveCardId(null);
      setDocument(null);
      setMode("navigation");
    }
    setNotice({
      tone: "info",
      message: "Document moved to Trash.",
    });
  }

  async function handleImportMarkdown() {
    try {
      await forceSaveCurrentDocument();
      const document = await importMarkdownDocument();

      if (!document) {
        return;
      }

      setRecentDocumentPaths(rememberLastDocumentPath(document.path));
      setDocument(document);
      setNotice({
        tone: "info",
        message: `Imported Markdown into "${document.name}".`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(error, "Fablecraft could not import that Markdown file."),
      });
    }
  }

  async function handleEnableCodex() {
    try {
      const status = await enableCodexIntegration();
      setIntegrationStatuses((currentStatuses) => ({
        ...currentStatuses,
        codex: status,
      }));
      setNotice({
        tone: "info",
        message: status.enabled
          ? "Codex integration is enabled. Open a new Codex session to pick it up."
          : "Fablecraft could not confirm the Codex integration status.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(
          error,
          "Fablecraft could not enable the Codex integration.",
        ),
      });
    }
  }

  async function handleEnableClaudeDesktop() {
    try {
      const status = await enableClaudeDesktopIntegration();
      setIntegrationStatuses((currentStatuses) => ({
        ...currentStatuses,
        claudeDesktop: status,
      }));
      setNotice({
        tone: "info",
        message: status.enabled
          ? "Claude Desktop integration is enabled. Restart Claude Desktop and start a new chat."
          : "Fablecraft could not confirm the Claude Desktop integration status.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: noticeMessage(
          error,
          "Fablecraft could not enable the Claude Desktop integration.",
        ),
      });
    }
  }

  function runPaletteAction(action: () => void | Promise<void>) {
    closeAuxiliaryOverlays();
    setMode("navigation");
    void action();
  }

  async function exportLevelFromMenu(format: "markdown" | "html") {
    if (!activeSnapshot || !activeDocument || !activeCardId) {
      return;
    }

    const result = await exportCurrentLevelToFile(
      activeSnapshot,
      activeCardId,
      activeDocument.name,
      format,
    );

    if (!result) {
      return;
    }

    setNotice({
      tone: "info",
      message: `Exported ${result.cardCount} card${result.cardCount === 1 ? "" : "s"} from level ${result.depth} as ${format === "markdown" ? "Markdown" : "HTML"}.`,
    });
  }

  function mergeSelectedCard(direction: "above" | "below") {
    if (!selectedCard) {
      return;
    }

    if (direction === "above" && !canMergeWithAbove) {
      return;
    }

    if (direction === "below" && !canMergeWithBelow) {
      return;
    }

    setMode("navigation");
    applyNavigationChange((snapshotToChange) =>
      direction === "above"
        ? mergeCardWithPreviousSibling(snapshotToChange, selectedCard.id)
        : mergeCardWithNextSibling(snapshotToChange, selectedCard.id),
    );
    setActiveCardId(selectedCard.id);
  }

  function handleNativeMenuAction(action: NativeMenuAction) {
    if (action === "show-history") {
      if (!useDocumentStore.getState().restoringHistory &&
        (!historyShortcutsSuspended || mode === "command" || mode === "search")) {
        if (mode === "command" || mode === "search") setMode(overlayReturnMode);
        void toggleHistory();
      }
      return;
    }
    if (historyBlocksLive || useDocumentStore.getState().historicalPreview ||
      useInteractionStore.getState().workspaceDialog) return;
    if (openHistory && (action === "layout-tree" || action === "layout-manuscript" ||
      action === "pane-left" || action === "pane-right")) {
      changeHistoryPane(action === "layout-tree" || action === "pane-left" ? "tree" : "manuscript");
      return;
    }
    if (openHistory && action === "layout-both") return;
    dispatchNativeMenuAction(action);

    if (action === "reload-window") {
      void forceSaveCurrentDocument().then(() => window.location.reload()).catch((error: unknown) => {
        setNotice({ tone: "error", message: noticeMessage(error, "Fablecraft could not flush pending edits.") });
      });
      return;
    }

    if (action === "new-document") {
      void handleNewDocument();
      return;
    }

    if (action === "open-document") {
      void handleOpenDocument();
      return;
    }

    if (action === "open-recent") {
      openRecentDocumentsOverlay();
      return;
    }

    if (action === "import-markdown") {
      void handleImportMarkdown();
      return;
    }

    if (action === "save") {
      void handleForceSave();
      return;
    }

    if (action === "check-for-updates") {
      void handleCheckForUpdates({ manual: true });
      return;
    }

    if (action === "export-markdown") {
      if (useInteractionStore.getState().workspacePane === "tree") void exportLevelFromMenu("markdown");
      return;
    }

    if (screen !== "workspace") {
      return;
    }

    if (action === "search") {
      if (useInteractionStore.getState().workspacePane === "tree" && !useInteractionStore.getState().workspaceDialog) openSearchOverlay();
      return;
    }

    if (action === "command-palette") {
      openCommandPalette();
      return;
    }

    if (action === "settings") {
      openSettingsDialog();
      return;
    }

    if (action === "help-shortcuts") {
      openHelpSheet("shortcuts");
      return;
    }

    if (action === "help-getting-started") {
      openHelpSheet("getting-started");
      return;
    }

    if (action === "help-commands") {
      openHelpSheet("commands");
      return;
    }

    if (action === "help-report-bug") {
      openFeedbackDialog("bug");
      return;
    }

    if (action === "help-request-feature") {
      openFeedbackDialog("feature");
      return;
    }

    if (action === "enable-codex") {
      void handleEnableCodex();
      return;
    }

    if (action === "enable-claude-desktop") {
      void handleEnableClaudeDesktop();
    }
  }

  nativeMenuActionHandlerRef.current = handleNativeMenuAction;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    async function attachNativeMenuListener() {
      const cleanup = await listenForNativeMenuActions((action) => {
        nativeMenuActionHandlerRef.current(action);
      });

      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
    }

    void attachNativeMenuListener();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    function openFirstDocumentPath(paths: string[]) {
      const path = paths.find((entry) => entry.toLowerCase().endsWith(".fable"));

      if (path) {
        openDocumentPathHandlerRef.current(path);
      }
    }

    async function drainPendingOpenDocumentPaths() {
      openFirstDocumentPath(await takePendingOpenDocumentPaths());
    }

    async function attachNativeOpenDocumentListener() {
      const cleanup = await listenForNativeOpenDocuments((paths) => {
        openFirstDocumentPath(paths);
        void takePendingOpenDocumentPaths();
      });

      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
      void drainPendingOpenDocumentPaths();
    }

    void attachNativeOpenDocumentListener();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const workspacePane = useInteractionStore((state) => state.workspacePane);
  const workspaceSplitFits = useInteractionStore((state) => state.workspaceSplitFits);
  const manuscriptLinkEligible = useInteractionStore((state) => state.manuscriptLinkEligible);
  const workspaceDialog = useInteractionStore((state) => state.workspaceDialog);
  const documentOpen = Boolean(activeSnapshot);
  const hasManuscript = Boolean(activeSnapshot?.manuscript);
  const nativeWorkspaceDialog = Boolean(historyBlocksLive || workspaceDialog || isSettingsOpen || helpSheetMode || feedbackDialogMode ||
    isRecentDocumentsOpen || appUpdateDialogStatus || mode === "command" || mode === "search");
  useEffect(() => {
    if (!isTauri()) return;
    void updateWorkspaceMenu({
      documentOpen,
      manuscript: hasManuscript,
      treeActive: workspacePane === "tree",
      splitFits: workspaceSplitFits,
      dialog: nativeWorkspaceDialog,
      link: manuscriptLinkEligible,
    }).catch(console.error);
  }, [documentOpen, hasManuscript, workspacePane, workspaceSplitFits, nativeWorkspaceDialog, manuscriptLinkEligible]);
  const commandItems: CommandPaletteItem[] = [
    ...(documentOpen ? [{
      id: "show-history",
      keywords: ["snapshots", "revisions", "restore"],
      label: openHistory ? "Close History" : "Show History",
      run: () => {
        setMode(overlayReturnMode);
        void toggleHistory();
      },
    }] : []),
    {
      id: "getting-started",
      keywords: ["first time", "guide", "intro", "help"],
      label: "Getting Started",
      run: () => {
        openHelpSheet("getting-started");
      },
    },
    {
      id: "help",
      keywords: ["commands", "groups"],
      label: "Show Command List",
      run: () => {
        openHelpSheet("commands");
      },
    },
    {
      id: "open-settings",
      keywords: ["theme", "font", "line height"],
      label: "Settings",
      run: () => {
        openSettingsDialog();
      },
    },
    {
      id: "check-for-updates",
      keywords: ["update", "upgrade", "release", "version"],
      label: "Check for Updates",
      run: () => runPaletteAction(() => handleCheckForUpdates({ manual: true })),
    },
    {
      id: "view-wide-lens",
      keywords: ["zoom", "overview", "tree", "graph", "view"],
      label: "Wide Lens",
      run: () => runPaletteAction(() => dispatchNativeMenuAction("view-wide-lens")),
    },
    {
      id: "view-normal",
      keywords: ["zoom", "writing", "neighbors", "view"],
      label: "Normal",
      run: () => runPaletteAction(() => dispatchNativeMenuAction("view-normal")),
    },
    {
      id: "view-focused",
      keywords: ["zoom", "writing", "document", "distraction", "view"],
      label: "Focused",
      run: () => runPaletteAction(() => dispatchNativeMenuAction("view-focused")),
    },
    {
      id: "enable-codex",
      keywords: ["mcp", "integration", "codex"],
      label: `${integrationStatuses.codex.enabled ? "✓ " : ""}Enable Codex`,
      run: () => runPaletteAction(handleEnableCodex),
    },
    {
      id: "enable-claude-desktop",
      keywords: ["mcp", "integration", "claude", "desktop"],
      label: `${integrationStatuses.claudeDesktop.enabled ? "✓ " : ""}Enable Claude Desktop`,
      run: () => runPaletteAction(handleEnableClaudeDesktop),
    },
    {
      id: "new-document",
      keywords: ["create"],
      label: "New Document",
      run: () => runPaletteAction(handleNewDocument),
    },
    {
      id: "open-document",
      keywords: ["reopen"],
      label: "Open Document",
      run: () => runPaletteAction(handleOpenDocument),
    },
    {
      id: "open-recent",
      keywords: ["reopen", "recent", "last"],
      label: "Open Recent",
      run: () => runPaletteAction(openRecentDocumentsOverlay),
    },
    {
      id: "import-markdown",
      keywords: ["md"],
      label: "Import Markdown",
      run: () => runPaletteAction(handleImportMarkdown),
    },
    {
      id: "export-markdown",
      keywords: ["md", "export", "selected level"],
      label: "Export Level as Markdown",
      run: () => runPaletteAction(() => exportLevelFromMenu("markdown")),
    },
    {
      id: "export-html",
      keywords: ["html", "export", "selected level"],
      label: "Export Level as HTML",
      run: () => runPaletteAction(() => exportLevelFromMenu("html")),
    },
    {
      id: "show-shortcuts",
      keywords: ["keys"],
      label: "Show Shortcuts",
      run: () => {
        openHelpSheet("shortcuts");
      },
    },
    {
      id: "report-bug",
      keywords: ["bug", "problem", "issue", "broken", "wrong", "error"],
      label: "Report a Bug",
      run: () => runPaletteAction(() => openFeedbackDialog("bug")),
    },
    {
      id: "request-feature",
      keywords: ["feature", "suggestion", "idea", "enhancement", "wish", "request"],
      label: "Request a Feature",
      run: () => runPaletteAction(() => openFeedbackDialog("feature")),
    },
  ].filter((item) => workspacePane === "tree" || (item.id !== "export-markdown" && item.id !== "export-html"));

  for (const [id, label] of manuscriptCommands) {
    const needsManuscript = id === "remove-manuscript" || id === "export-manuscript-markdown"
      || id === "link-manuscript-passage";
    const eligible = id !== "link-manuscript-passage" || manuscriptLinkEligible;
    if (!activeSnapshot || (needsManuscript && !activeSnapshot.manuscript) ||
      !eligible) continue;
    commandItems.push({
      id,
      label: id === "layout-both" && !workspaceSplitFits ? `${label} (widen window)` : label,
      run: () => {
        restoreOverlayMode();
        dispatchNativeMenuAction(id);
      },
    });
  }

  function handleWindowDragMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !isTauri()) {
      return;
    }

    event.preventDefault();
    void getCurrentWindow().startDragging().catch((error: unknown) => {
      console.warn("Fablecraft could not start window dragging.", error);
    });
  }

  if (activeSnapshot && workspacePane === "tree") {
    if (selectedCard) {
      commandItems.push({
        id: "new-document-from-tree",
        keywords: ["convert card to document", "extract", "move", "subtree"],
        label: "New Document From Tree",
        run: () => runPaletteAction(handleNewDocumentFromTree),
      });
    }

    if (selectedCard && canMergeWithAbove) {
      commandItems.push({
        id: "merge-with-above",
        keywords: ["merge", "join", "combine", "up"],
        label: "Merge with Above",
        run: () => mergeSelectedCard("above"),
      });
    }

    if (selectedCard && canMergeWithBelow) {
      commandItems.push({
        id: "merge-below",
        keywords: ["merge", "join", "combine", "down"],
        label: "Merge Below",
        run: () => mergeSelectedCard("below"),
      });
    }
  }

  return (
    <main className="fc-desktop-shell h-screen overflow-clip bg-[var(--fc-color-app)] text-[var(--fc-color-text)] antialiased">
      <div
        className="fc-window-drag-region fixed inset-x-0 top-0 z-20"
        data-tauri-drag-region
        onMouseDown={handleWindowDragMouseDown}
      />
      <div
        className={
          screen === "workspace"
            ? "flex h-full w-full items-stretch"
            : "mx-auto flex h-full w-full max-w-[1680px] items-center justify-center px-6 py-10"
        }
      >
        {screen === "startup" && (
          <StartupPanel
            onOpenGettingStarted={() => {
              setHelpSheetMode("getting-started");
            }}
            onRefreshRecentDocuments={refreshRecentDocuments}
            onOpenRecentDocument={(path) => void handleOpenRecentDocument(path)}
            onRecentDocumentsChange={setRecentDocumentPaths}
            recentDocumentPaths={recentDocumentPaths}
          />
        )}

        {screen === "workspace" && activeDocument && (
          <div className="fc-history-workspace" data-history={Boolean(openHistory)}
            data-narrow={historyNarrow} style={{
              "--fc-history-width": `${historyLayoutTokens.timelineWidth}px`,
              "--fc-history-gap": `${historyLayoutTokens.gap}px`,
              "--fc-history-padding": `${historyLayoutTokens.padding}px`,
            } as CSSProperties}>
            <div className="fc-history-live" hidden={Boolean(openHistory && historyBlocksLive)}
              inert={historyBlocksLive}>
              {openHistory && historyNarrow && openHistory.surfaceVisible && (
                <div className="fc-history-current-bar">
                  <button type="button" onClick={() => {
                    showHistorySurface(false);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(".fc-history-timeline [aria-current=true]")?.focus({ preventScroll: true }));
                  }}>Back</button>
                  <span>Current</span>
                </div>
              )}
              <div className="fc-history-live-surface">
                <DocumentWorkspace
                  document={activeDocument}
                  onDocumentCreated={handleWorkspaceDocumentCreated}
                  onDocumentDeleted={handleWorkspaceDocumentDeleted}
                  onDocumentRenamed={handleWorkspaceDocumentRenamed}
                  onOpenDocumentPath={handleOpenDocumentPath}
                  historyOpen={Boolean(openHistory)}
                  historyPane={openHistory?.pane}
                  onTreeViewMode={setTreeViewMode}
                  historyPaneRequest={historyPaneRequest?.session === documentSession ? historyPaneRequest : null}
                  suspendKeyboard={historyBlocksLive || Boolean(isSettingsOpen || helpSheetMode ||
                    feedbackDialogMode || isRecentDocumentsOpen || appUpdateDialogStatus)}
                />
              </div>
            </div>
            {openHistory && activeSnapshot && (
              <DocumentHistory key={openHistory.session} document={activeDocument} current={activeSnapshot}
                session={openHistory.session} pane={openHistory.pane} treeViewMode={treeViewMode}
                firstPage={firstHistoryPage}
                narrow={historyNarrow} surfaceVisible={openHistory.surfaceVisible}
                shortcutsSuspended={historyShortcutsSuspended}
                onPane={changeHistoryPane} onSurfaceVisible={showHistorySurface}
                onClose={() => closeHistory()} onRestore={closeHistory} />
            )}
          </div>
        )}
      </div>

      {screen === "workspace" && mode === "command" && (
        <CommandPalette
          commands={commandItems}
          onClose={restoreOverlayMode}
        />
      )}

      {isRecentDocumentsOpen && (
        <RecentDocumentsOverlay
          onClose={closeRecentDocumentsOverlay}
          onOpenDocument={(path) => void handleOpenRecentDocument(path)}
          recentDocumentPaths={recentDocumentPaths}
        />
      )}

      {screen === "workspace" && mode === "search" && activeSnapshot && (
        <SearchOverlay
          onClose={restoreOverlayMode}
          onJump={(cardId) => {
            setActiveCardId(cardId);
            setMode("navigation");
          }}
          snapshot={activeSnapshot}
        />
      )}

      {screen === "workspace" && isSettingsOpen && (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            restoreOverlayMode();
          }}
        />
      )}

      {helpSheetMode && (
        <HelpSheet
          mode={helpSheetMode}
          onClose={() => {
            setHelpSheetMode(null);
            if (screen === "workspace") {
              restoreOverlayMode();
            }
          }}
        />
      )}

      {feedbackDialogMode && (
        <FeedbackDialog
          mode={feedbackDialogMode}
          onClose={() => {
            setFeedbackDialogMode(null);
            restoreOverlayMode();
          }}
        />
      )}

      {appUpdateDialogStatus && (
        <AppUpdateDialog
          errorMessage={appUpdateErrorMessage}
          onClose={closeAppUpdateDialog}
          onInstall={() => void handleInstallAppUpdate()}
          progress={appUpdateProgress}
          status={appUpdateDialogStatus}
          update={appUpdate}
        />
      )}

      {notice && (
        <div
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          className="pointer-events-none fixed right-4 top-4 z-50 w-[min(calc(100vw-2rem),360px)] border border-[var(--fc-color-notice-border)] bg-[var(--fc-color-notice-surface)] px-5 py-4 font-[var(--fc-font-ui)] text-sm leading-6 text-[var(--fc-color-notice-text)] shadow-[var(--fc-shadow-elevated)] sm:right-6 sm:top-6"
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}

      {showBetaBar && (
        <div className="fixed bottom-0 inset-x-0 z-30 flex items-center bg-black px-4 py-3 text-sm text-white/70">
          <div className="flex flex-1 items-center justify-center gap-1">
            <span>This is a beta version of Fablecraft.</span>
            <button
              className="text-white underline underline-offset-2 hover:text-white/80"
              onClick={() => setFeedbackDialogMode("bug")}
            >
              Report a problem
            </button>
            <span>·</span>
            <button
              className="text-white underline underline-offset-2 hover:text-white/80"
              onClick={() => setFeedbackDialogMode("feature")}
            >
              Request a feature.
            </button>
          </div>
          <button
            aria-label="Dismiss"
            className="text-white/50 hover:text-white"
            onClick={() => {
              rememberBetaNoticeDismissal();
              setShowBetaBar(false);
            }}
          >
            ✕
          </button>
        </div>
      )}

    </main>
  );
}
