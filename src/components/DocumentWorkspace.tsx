import { toEditableDocumentSnapshot } from "../domain/document/serialization";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { ManuscriptPane, type ManuscriptPaneHandle } from "./ManuscriptPane";
import { ManuscriptBacklinks } from "./ManuscriptBacklinks";
import { manuscriptUuid, passageIndex, type PassageEntry } from "../domain/document/manuscript";
import { exportManuscriptMarkdown, manuscriptSchema, parseManuscriptMarkdown } from "../domain/document/manuscriptMarkdown";
import { paneShortcut, splitMinimumWidth, splitTreeWidth, stepWorkspace, type WorkspaceLayout, type WorkspacePane } from "../domain/document/manuscriptLayout";
import { manuscriptLayoutTokens } from "../styles/tokens";
import { promptForExportPath, promptForMarkdownImportPath } from "../app/documentActions";
import { readTextFileAtPath, writeTextFileAtPath } from "../storage/textFiles";
import { ensureFableExtension, fileStem } from "../storage/filePaths";
import { arrangeWritingStage, writingViewport } from "../domain/document/writingLayout";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type WheelEvent as ReactWheelEvent } from "react";
import { CardEditor } from "./CardEditor";
import { OverlayShell } from "./OverlayShell";
import { TreeCardButton } from "./TreeCardButton";
import { useCardNavigationMotion } from "./useCardNavigationMotion";
import { CardIdentity } from "./CardIdentity";
import { referenceTree } from "../domain/document/references";
import { buildDescendantCountMap } from "../domain/document/descendantCounts";
import { buildCardNumberMap } from "../domain/document/cardNumbers";
import {
  CARD_CLIPBOARD_MIME_TYPE,
  createCardCopyPayload,
  createCardSubtreeCopyPayload,
  createCardCutPayload,
  decodeCardClipboardPayload,
  encodeCardClipboardPayload,
  pasteCardClipboardPayloadWithResult,
  removeCutSubtree,
  type CardClipboardPayload,
} from "../domain/document/clipboard";
import {
  canCreateCardsFromContent,
  cardContent,
  contentText,
  isContentEffectivelyEmpty,
  replaceCardContent,
  trimTrailingEmptyParagraphs,
} from "../domain/document/content";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../domain/document/editorDocument";
import {
  firstChildCardId,
  navigationBoundaryCardId,
  preferredChildCardId,
  parentCardId,
} from "../domain/document/navigation";
import { ancestorsOfCard, nextCardInColumn, overviewTreeLayout, previousCardInColumn, stageLayout } from "../domain/document/spatial";
import { splitCardContentAtTextOffset } from "../domain/document/split";
import { createChildCard, createSiblingAfter, createSiblingBefore, deleteCardSubtree, indentCardUnderPreviousSibling, mergeCardWithNextSibling, mergeCardWithPreviousSibling, moveCardWithinParent, outdentCard, unwrapCard, wrapLevelInParent } from "../domain/document/tree";
import { listenForFrontendMenuActions, type NativeMenuAction } from "../lib/nativeMenu";
import { randomId } from "../lib/randomId";
import { loadCurrentDocumentSnapshot, saveDocumentRecoveryCopy } from "../storage/documentSnapshots";
import {
  createUntitledDocumentInDirectory,
  deleteFableDocument,
  listCurrentDocumentDirectory,
  listFableDirectory,
  renameFableDocument,
  type FableDirectory,
  type FableDirectoryEntry,
} from "../storage/fableDirectory";
import { useDocumentAutosave } from "../storage/useDocumentAutosave";
import { useExternalDocumentReload } from "../storage/useExternalDocumentReload";
import { useAppStore } from "../state/appStore";
import { useDocumentStore } from "../state/documentStore";
import { createInteractionStore, useInteractionStore } from "../state/interactionStore";
import { useSettingsStore } from "../state/settingsStore";
import { writingLayoutTokens, resolveUiMetrics, type UiPreferences } from "../styles/tokens";
import type { DocumentSnapshot } from "../domain/document/types";
import type { DocumentSummary } from "../types/document";
import type { HistoryChange } from "../storage/documentHistory";
import type { HistoryTextRange } from "./historyAdditions";

export type WorkspaceViewMode = "wide-lens" | "normal" | "focused";
export type HistoryEditTarget = { pane: WorkspacePane; cardId?: string };

interface HistoryWorkspacePreview {
  snapshot: DocumentSnapshot;
  pane: WorkspacePane;
  focus: { cardId?: string; passage?: { from: number; to: number }; cardRange?: { from: number; to: number }; request: number };
  changes: readonly HistoryChange[];
  initialViewMode: WorkspaceViewMode;
  navigationRequest?: number;
  onPane: (pane: WorkspacePane) => void;
  onCard: (cardId: string | null) => void;
}

function ignorePreviewMode() {}

function LiveWorkspaceSync({ document }: { document: DocumentSummary }) {
  useDocumentAutosave();
  useExternalDocumentReload(document);
  return null;
}

interface DocumentWorkspaceProps {
  disableScrollPan?: boolean;
  document: DocumentSummary;
  onDocumentCreated?: (document: DocumentSummary) => void;
  onDocumentDeleted?: (path: string) => void;
  onDocumentRenamed?: (document: DocumentSummary, previousPath: string) => void;
  onOpenDocumentPath?: (path: string) => Promise<void> | void;
  suspendKeyboard?: boolean;
  historyOpen?: boolean;
  historyPane?: WorkspacePane;
  historyPaneRequest?: HistoryEditTarget & { startEditing?: boolean; keepEditing?: boolean } | null;
  historyPreview?: HistoryWorkspacePreview;
  onTreeViewMode?: (viewMode: WorkspaceViewMode) => void;
}

type EditorFocusPlacement = "end" | "start";
type DeleteDocumentAction = "cancel" | "delete";
type ExplorerSelection =
  | { documentPath?: string; kind: "card"; parentPath?: string }
  | { kind: "current-document" }
  | { kind: "folder" }
  | { kind: "entry"; path: string }
  | { kind: "preview-entry"; parentPath: string; path: string };

const OVERVIEW_CARD_WIDTH = 236;
const OVERVIEW_CARD_HEIGHT = 72;
const OVERVIEW_COLUMN_GAP = 156;
const OVERVIEW_SCALE = 0.82;
const OVERVIEW_SIBLING_GAP = 18;
const OVERVIEW_PREFERRED_SIBLING_CENTER_GAP = 148;
const OVERVIEW_MAX_SIBLING_CENTER_GAP = 200;
const ACTIVE_CARD_VIEWPORT_BUFFER = writingLayoutTokens.verticalInset;
const RECENTER_WHEEL_SUPPRESSION_MS = 700;

function estimateRichCardHeight(
  contentJson: string,
  metrics: ReturnType<typeof resolveUiMetrics>,
  preferences: UiPreferences,
) {
  const text = contentText(contentJson);

  if (text.trim().length === 0) {
    return metrics.cardHeight;
  }

  const horizontalPadding = 68;
  const availableTextWidth = Math.max(240, metrics.cardWidth - horizontalPadding);
  const averageCharacterWidth = preferences.textSize === "large" ? 10.5 : 9.6;
  const charactersPerLine = Math.max(
    24,
    Math.floor(availableTextWidth / averageCharacterWidth),
  );
  const lineHeight = preferences.lineHeight === "relaxed" ? 32 : 28;
  const verticalPadding = 66;
  const blockSpacing = 12;
  const lines = text.split("\n");
  const visualLineCount = lines.reduce((lineCount, line) => {
    if (line.trim().length === 0) {
      return lineCount + 0.35;
    }

    return lineCount + Math.max(1, Math.ceil(line.length / charactersPerLine));
  }, 0);
  const nonEmptyBlocks = lines.filter((line) => line.trim().length > 0).length;
  const estimatedHeight =
    verticalPadding +
    visualLineCount * lineHeight +
    Math.max(0, nonEmptyBlocks - 1) * blockSpacing;

  return Math.max(metrics.cardHeight, Math.ceil(estimatedHeight));
}

function cardHeightCacheKey(cardId: string) {
  return cardId;
}

function clampStageOffset(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

function measuredLayoutHeight(element: HTMLElement) {
  return Math.max(element.offsetHeight, element.scrollHeight);
}

function viewportHeight() {
  return typeof window === "undefined" ? 800 : window.innerHeight;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function explorerLabelForEntry(entry: FableDirectoryEntry) {
  return entry.kind === "document"
    ? entry.name.replace(/\.fable$/i, "")
    : entry.name;
}

function documentNameWithoutExtension(pathOrName: string) {
  return fileNameFromPath(pathOrName).replace(/\.fable$/i, "");
}

function entryId(entry: FableDirectoryEntry) {
  return `${entry.kind}:${entry.path}`;
}

function ExplorerCard({
  isActive,
  isRenaming = false,
  kind,
  label,
  meta,
  onClick,
  onRenameCancel,
  onRenameCommit,
  onRenameDraftChange,
  renameDraft = "",
  renameInputRef,
  width,
  x,
  y,
}: {
  isActive: boolean;
  isRenaming?: boolean;
  kind: "folder" | "document";
  label: string;
  meta: string;
  onClick: () => void;
  onRenameCancel?: () => void;
  onRenameCommit?: () => void;
  onRenameDraftChange?: (value: string) => void;
  renameDraft?: string;
  renameInputRef?: RefObject<HTMLInputElement | null>;
  width: number;
  x: number;
  y: number;
}) {
  function handleRenameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onRenameCommit?.();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onRenameCancel?.();
      return;
    }

    event.stopPropagation();
  }

  return (
    <button
      className="absolute flex min-h-[var(--fc-card-height)] cursor-pointer appearance-none flex-col justify-center border-0 px-6 py-6 text-left transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
      data-explorer-kind={kind}
      data-is-active={String(isActive)}
      data-testid="directory-card"
      onClick={onClick}
      tabIndex={-1}
      style={{
        backgroundColor:
          kind === "folder"
            ? "var(--fc-color-explorer-folder-surface)"
            : "var(--fc-color-explorer-document-surface)",
        boxShadow: isActive ? "var(--fc-shadow-elevated)" : "none",
        left: `calc(50% + ${x}px)`,
        minHeight: "var(--fc-card-height)",
        top: `calc(50% + ${y}px)`,
        transform: "translate(-50%, -50%)",
        zIndex: isActive ? 3 : 1,
        width: `${width}px`,
      }}
      type="button"
    >
      <span className="font-[var(--fc-font-ui)] text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fc-color-card-label)]">
        {meta}
      </span>
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="mt-2 w-full bg-transparent font-[var(--fc-font-ui)] text-[17px] font-semibold leading-tight text-[var(--fc-color-text)] outline-none"
          onChange={(event) => onRenameDraftChange?.(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onInput={(event) => onRenameDraftChange?.(event.currentTarget.value)}
          onKeyDown={handleRenameKeyDown}
          value={renameDraft}
        />
      ) : (
        <span className="mt-2 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-[var(--fc-font-ui)] text-[17px] font-semibold leading-tight text-[var(--fc-color-text)]">
          {label}
        </span>
      )}
    </button>
  );
}

function descendantCardIds(cards: DocumentSnapshot["cards"], cardId: string) {
  const descendants: string[] = [];
  const queue = [cardId];

  while (queue.length > 0) {
    const currentCardId = queue.shift()!;
    const childIds = cards
      .filter((card) => card.parentId === currentCardId)
      .map((card) => card.id);

    descendants.push(...childIds);
    queue.push(...childIds);
  }

  return descendants;
}

function previouslyVisitedSurvivingCardId(snapshot: DocumentSnapshot, cardId: string) {
  const removedIds = new Set([cardId, ...descendantCardIds(snapshot.cards, cardId)]);
  const survivingIds = new Set(
    snapshot.cards.filter((card) => !removedIds.has(card.id)).map((card) => card.id),
  );
  return useInteractionStore.getState().previousCardIds.find((id) => survivingIds.has(id));
}

function fallbackCardIdAfterDelete(snapshot: DocumentSnapshot, cardId: string) {
  return (
    previouslyVisitedSurvivingCardId(snapshot, cardId) ??
    nextCardInColumn(snapshot.cards, cardId) ??
    previousCardInColumn(snapshot.cards, cardId) ??
    parentCardId(snapshot.cards, cardId) ??
    null
  );
}

function fallbackCardIdAfterEmptyAbandon(snapshot: DocumentSnapshot, cardId: string) {
  return (
    previouslyVisitedSurvivingCardId(snapshot, cardId) ??
    parentCardId(snapshot.cards, cardId) ??
    fallbackCardIdAfterDelete(snapshot, cardId)
  );
}

function savedWorkspaceLayout(documentId: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(`fablecraft.workspace.${documentId}`) ?? "null");
    if (saved && ["both", "tree", "manuscript"].includes(saved.layout) &&
      Number.isFinite(saved.ratio) && saved.ratio > 0 && saved.ratio < 1) {
      return saved as { layout: WorkspaceLayout; ratio: number };
    }
  } catch { /* Layout preferences are optional. */ }
  return { layout: "tree" as const, ratio: manuscriptLayoutTokens.initialTreeRatio };
}

export function DocumentWorkspace({
  disableScrollPan = false,
  document,
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentRenamed,
  onOpenDocumentPath,
  suspendKeyboard = false,
  historyOpen = false,
  historyPane,
  historyPaneRequest = null,
  historyPreview,
  onTreeViewMode,


}: DocumentWorkspaceProps) {
  const readOnly = Boolean(historyPreview);
  const historyChanges = historyPreview?.changes;
  const historyAdditions = useMemo(() => {
    const cards = new Map<string, HistoryTextRange[]>();
    let manuscript: HistoryTextRange[] | undefined;
    for (const change of historyChanges ?? []) {
      if (change.kind === "manuscript") manuscript = change.addedRanges;
      else if (change.card && change.addedRanges?.length) cards.set(change.card.id, change.addedRanges);
    }
    return { cards, manuscript };
  }, [historyChanges]);
  const [interaction] = useState(() => historyPreview ? createInteractionStore() : useInteractionStore);
  const workspaceRef = useRef<HTMLElement>(null);
  const manuscriptRef = useRef<ManuscriptPaneHandle>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const [presentation, setPresentation] = useState(() => ({
    documentId: document.documentId, ...savedWorkspaceLayout(document.documentId),
    ...(historyPreview && { layout: historyPreview.pane }),
  }));
  const [activePane, setActivePane] = useState<WorkspacePane>(historyPreview?.pane ?? "tree");
  const treePaneActive = activePane === "tree";
  const [linkedManuscriptCard, setLinkedManuscriptCard] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<{
    cardId: string | null;
    mode: "navigation" | "editing";
  } | null>(null);
  const [revealPassage, setRevealPassage] = useState<{ from: number; to: number; request: number } | null>(null);
  const revealRequest = useRef(0);
  const manuscriptFileDialog = useRef(false);
  const focusRequest = useRef<WorkspacePane | null>(null);
  const splitFits = workspaceWidth >= splitMinimumWidth;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overviewConnectorsRef = useRef<SVGSVGElement | null>(null);
  const activeCardShellRef = useRef<HTMLDivElement | null>(null);
  const cardClipboardFallbackRef = useRef<{
    payload: CardClipboardPayload;
    text: string;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const deletedPathsRef = useRef(new Set<string>());
  const deleteInFlightRef = useRef(false);
  const createInFlightRef = useRef(false);
  const newlyCreatedDocumentPathRef = useRef<string | null>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const tabKeyHeldRef = useRef(false);
  const previousCenterTargetRef = useRef<{
    activeCardId: string | null;
    appearanceId: string | null;
    documentId: string;
  } | null>(null);
  const wheelPanSuppressedUntilRef = useRef(0);
  const wrappedParentSourceChildRef = useRef<Record<string, string>>({});
  const [pendingEditorFocusPlacement, setPendingEditorFocusPlacement] =
    useState<EditorFocusPlacement | null>(null);
  const [pendingEditorTextInput, setPendingEditorTextInput] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>(historyPreview?.initialViewMode ?? "normal");
  const isOverviewMode = viewMode === "wide-lens";
  const isFocusedMode = viewMode === "focused";
  const [stageOffset, setStageOffset] = useState({ x: 0, y: 0 });
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [workspaceViewportWidth, setWorkspaceViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [workspaceViewportHeight, setWorkspaceViewportHeight] =
    useState(viewportHeight);
  const [twoColumnPlacement, setTwoColumnPlacement] = useState<{
    documentId: string;
    parentId: string;
    showParent: boolean;
  } | null>(null);
  const [directory, setDirectory] = useState<FableDirectory | null>(null);
  const [parentDirectory, setParentDirectory] = useState<FableDirectory | null>(null);
  const [previewDirectory, setPreviewDirectory] = useState<FableDirectory | null>(null);
  const [directoryLoadError, setDirectoryLoadError] = useState<string | null>(null);
  const [documentDeleteError, setDocumentDeleteError] = useState<string | null>(null);
  const [pendingDeleteDocument, setPendingDeleteDocument] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const [selectedDeleteDocumentAction, setSelectedDeleteDocumentAction] =
    useState<DeleteDocumentAction>("cancel");
  const [explorerSelection, setExplorerSelection] = useState<ExplorerSelection>({
    kind: "card",
  });
  const [renamingDocumentPath, setRenamingDocumentPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const activeCardId = interaction((state) => state.activeCardId);
  const setActiveCardId = interaction((state) => state.setActiveCardId);
  const referencePath = interaction((state) => state.referencePath);
  const setActiveAppearance = interaction((state) => state.setActiveAppearance);
  const clearReferencePath = interaction((state) => state.clearReferencePath);
  const rememberedChildIds = interaction((state) => state.rememberedChildIds);
  const rememberChild = interaction((state) => state.rememberChild);
  const clearChildMemory = interaction((state) => state.clearChildMemory);
  const clearCardVisitHistory = interaction((state) => state.clearCardVisitHistory);
  useEffect(() => {
    clearChildMemory();
    clearCardVisitHistory();
    clearReferencePath();
  }, [document.documentId, clearChildMemory, clearCardVisitHistory, clearReferencePath]);
  const liveMode = useAppStore((state) => state.mode);
  const liveSetMode = useAppStore((state) => state.setMode);
  const mode = readOnly ? "navigation" : liveMode;
  const setMode = readOnly ? ignorePreviewMode : liveSetMode;
  const setNotice = useAppStore((state) => state.setNotice);
  const uiPreferences = useSettingsStore((state) => state.preferences);
  const applyNavigationChange = useDocumentStore(
    (state) => state.applyNavigationChange,
  );
  const hydrateSnapshot = useDocumentStore((state) => state.hydrateSnapshot);
  const redoNavigation = useDocumentStore((state) => state.redoNavigation);
  const redoEditing = useDocumentStore((state) => state.redoEditing);
  const snapshot = useDocumentStore((state) => readOnly ? null : state.snapshot);
  const revisionConflict = useDocumentStore((state) => !readOnly && state.revisionConflict);
  const saveError = useDocumentStore((state) => readOnly ? null : state.errorMessage);
  const [recovering, setRecovering] = useState(false);
  const undoNavigation = useDocumentStore((state) => state.undoNavigation);
  const undoEditing = useDocumentStore((state) => state.undoEditing);
  const updateSnapshot = useDocumentStore((state) => state.updateSnapshot);
  const updateSummary = useDocumentStore((state) => state.updateSummary);

  function updateCardHeight(
    cardId: string,
    height: number,
    overwrite = true,
  ) {
    const normalizedHeight = Math.max(uiMetrics.cardHeight, Math.round(height));
    const cacheKey = cardHeightCacheKey(cardId);

    setCardHeights((currentHeights) => {
      if (!overwrite && currentHeights[cacheKey]) {
        return currentHeights;
      }

      if (currentHeights[cacheKey] === normalizedHeight) {
        return currentHeights;
      }

      return {
        ...currentHeights,
        [cacheKey]: normalizedHeight,
      };
    });
  }

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const nextSnapshot = await loadCurrentDocumentSnapshot();

        if (!cancelled) {
          if (nextSnapshot.summary.documentId === document.documentId && nextSnapshot.summary.path === document.path) {
            hydrateSnapshot(nextSnapshot);
          }
        }
      } catch (error) {
        if (!cancelled) setNotice({ tone: "error",
          message: error && typeof error === "object" && "message" in error
            ? String(error.message) : "Could not load the document." });
      }
    }

    void loadSnapshot();

    return () => {
      cancelled = true;
    };
  }, [document.documentId, hydrateSnapshot, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;

    async function loadDirectory() {
      try {
        const nextDirectory = await listCurrentDocumentDirectory();

        if (!cancelled) {
          setDirectory(nextDirectory);
          setPreviewDirectory(null);
          setDirectoryLoadError(null);
          setExplorerSelection({ kind: "card" });
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setDirectory(null);
          setDirectoryLoadError(
            error instanceof Error ? error.message : "Could not read folder.",
          );
        }
      }
    }

    void loadDirectory();

    return () => {
      cancelled = true;
    };
  }, [document.documentId, readOnly]);

  useEffect(() => {
    let cancelled = false;
    setParentDirectory(null);

    if (explorerSelection.kind === "folder" && directory?.parentFolderPath) {
      const parentPath = directory.parentFolderPath;
      void listFableDirectory(parentPath).then(
        (listing) => {
          if (!cancelled && listing.folderPath === parentPath) {
            setParentDirectory(listing);
          }
        },
        (error) => {
          if (!cancelled) {
            setDirectoryLoadError(
              error instanceof Error ? error.message : "Could not read parent folder.",
            );
          }
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [directory?.folderPath, directory?.parentFolderPath, explorerSelection.kind]);

  const activeSnapshot =
    historyPreview?.snapshot ?? (snapshot?.summary.documentId === document.documentId ? snapshot : null);
  const referenceLayout = useMemo(() =>
    activeSnapshot ? referenceTree(activeSnapshot, activeCardId, referencePath) : null,
    [activeSnapshot?.cards, activeSnapshot?.contents, activeCardId, referencePath]);
  const activeAppearanceId = referenceLayout?.activeId ?? activeCardId;
  const activeAppearance = activeAppearanceId ? referenceLayout?.appearances.get(activeAppearanceId) : undefined;
  const isReferenceView = activeAppearance?.isReference ?? false;
  const isAliasCard = activeAppearance?.isAlias ?? false;
  const layoutCards = referenceLayout?.cards ?? [];
  const layoutCardById = new Map(layoutCards.map((card) => [card.id, card]));
  const activeLayoutCard = activeAppearanceId ? layoutCardById.get(activeAppearanceId) : undefined;
  const directChildren = new Set(layoutCards.filter((card) => card.parentId === activeAppearanceId).map((card) => card.id));
  const activeParentId = activeLayoutCard?.parentId ?? null;
  const isExplorerSelectionActive = explorerSelection.kind !== "card";
  const sameSiblingGroup = twoColumnPlacement?.documentId === document.documentId &&
    twoColumnPlacement.parentId === activeParentId;
  const showParentInTwoColumns = sameSiblingGroup
    ? twoColumnPlacement.showParent
    : activeParentId !== null && directChildren.size === 0;
  const directoryMetrics = resolveUiMetrics(uiPreferences);
  const writing = writingViewport(workspaceViewportWidth, writingLayoutTokens, {
    focused: isFocusedMode,
    showParentInTwoColumns,
  });
  // Keep the column choice for the current sibling group until leaving it or the two-column view.
  if (viewMode === "normal" && !isExplorerSelectionActive && writing.columns === 2 && activeParentId !== null) {
    if (!sameSiblingGroup) {
      setTwoColumnPlacement({ documentId: document.documentId, parentId: activeParentId, showParent: showParentInTwoColumns });
    }
  } else if (twoColumnPlacement !== null) {
    setTwoColumnPlacement(null);
  }
  const uiMetrics = { ...directoryMetrics, cardWidth: writing.cardWidth };
  const layoutRememberedChildren = useMemo(() =>
    ({ ...rememberedChildIds, ...referenceLayout?.preferredChildren }), [rememberedChildIds, referenceLayout]);
  const manuscript = activeSnapshot?.manuscript;
  const hadManuscript = useRef(false);
  const presentationReady = useRef(false);
  const savedLayout = presentation.documentId === document.documentId ? presentation.layout : "tree";
  const layout = historyPane ?? savedLayout;
  const bothVisible = !isExplorerSelectionActive && layout === "both" && splitFits;
  const linkedTreeCard = bothVisible && !treePaneActive ? linkedManuscriptCard : null;
  const showActiveCardStyle = treePaneActive || (linkedTreeCard !== null && linkedTreeCard === activeCardId && !referencePath);

  useLayoutEffect(() => {
    if (linkedTreeCard) setActiveCardId(linkedTreeCard);
  }, [linkedTreeCard, setActiveCardId]);
  const visiblePane = layout === "both" ? activePane : linkTarget ? "tree" : layout;
  const showTree = isExplorerSelectionActive || bothVisible || visiblePane === "tree";
  const showManuscript = !isExplorerSelectionActive && (bothVisible || visiblePane === "manuscript");
  const treeWidth = bothVisible ? splitTreeWidth(workspaceWidth, presentation.ratio) : undefined;
  const manuscriptEntries = useMemo(() => {
    if (!manuscript?.passages.length) return [];
    const doc = manuscriptRef.current?.documentFor(manuscript.contentJson)
      ?? manuscriptSchema.nodeFromJSON(JSON.parse(manuscript.contentJson));
    return passageIndex(doc, manuscript.passages);
  }, [manuscript]);
  const backlinks = useMemo(() => {
    const result = new Map<string, PassageEntry[]>();
    for (const passage of manuscriptEntries) {
      for (const id of passage.targetCardIds) {
        const entries = result.get(id);
        if (entries) entries.push(passage);
        else result.set(id, [passage]);
      }
    }
    return result;
  }, [manuscriptEntries]);

  function activatePane(pane: WorkspacePane) {
    interaction.setState({ workspacePane: pane });
    setActivePane(pane);
    if (pane === "tree") setRevealPassage(null);
  }

  function showLayout(next: WorkspaceLayout, focus?: WorkspacePane) {
    if (focus) focusRequest.current = focus;
    setPresentation((current) => ({ ...current, layout: next }));
    if (focus) activatePane(focus);
    if (focus === "tree") setRevealPassage(null);
  }

  function stepPane(direction: -1 | 1) {
    const treeContext = isExplorerSelectionActive;
    const next = stepWorkspace(treeContext ? "tree" : layout, treeContext ? "tree" : activePane, direction, splitFits);
    if (next.layout === layout && next.pane === activePane && !treeContext) return;
    if (treeContext && next.pane === "manuscript") preserveDocumentTreeExplorerContext();
    if (treeContext && direction < 0) return;
    showLayout(next.layout, next.pane);
  }

  function setTreeRatio(width: number) {
    const ratio = splitTreeWidth(workspaceWidth, width / workspaceWidth) / workspaceWidth;
    setPresentation((current) => ({ ...current, ratio }));
  }

  function showPassage(entry: PassageEntry) {
    if (linkTarget) return;
    if (historyPreview) {
      historyPreview.onPane("manuscript");
      setRevealPassage({ ...entry, request: ++revealRequest.current });
      return;
    }
    if (layout !== "both" && layout !== "manuscript") showLayout(splitFits ? "both" : "manuscript", "manuscript");
    else activatePane("manuscript");
    setRevealPassage({ ...entry, request: ++revealRequest.current });
  }

  function removeManuscriptBacklink(passageId: string, cardId: string) {
    if (linkTarget) return;
    updateSnapshot((snapshot) => {
      const manuscript = snapshot.manuscript;
      if (!manuscript?.passages.some((passage) => passage.id === passageId && passage.targetCardIds[0] === cardId)) {
        return snapshot;
      }
      return {
        ...snapshot,
        manuscript: { ...manuscript, passages: manuscript.passages.filter((passage) => passage.id !== passageId) },
      };
    });
  }

  function startLinkTargetSelection() {
    if (!manuscriptRef.current?.link()) return false;
    setLinkTarget({
      cardId: activeCardId,
      mode: useAppStore.getState().mode === "editing" ? "editing" : "navigation",
    });
    preserveDocumentTreeExplorerContext();
    tabKeyHeldRef.current = false;
    interaction.setState({ workspaceDialog: true });
    setMode("navigation");
    focusRequest.current = "tree";
    activatePane("tree");
    return true;
  }

  function finishLinkTargetSelection(restoreSelection = false) {
    if (!linkTarget) return;
    manuscriptRef.current?.clearLink(restoreSelection);
    setLinkTarget(null);
    interaction.setState({ workspaceDialog: false });
    setMode(activeCardId === linkTarget.cardId ? linkTarget.mode : "navigation");
    focusRequest.current = "manuscript";
    activatePane("manuscript");
  }

  function manuscriptMatchesOpenDocument(session: number) {
    const current = useDocumentStore.getState();
    return current.session === session && current.snapshot?.summary.documentId === document.documentId;
  }

  async function manuscriptFileAction(action: "import" | "export" | "remove") {
    const state = useDocumentStore.getState();
    if (manuscriptFileDialog.current || !activeSnapshot) return;
    manuscriptFileDialog.current = true;
    interaction.setState({ workspaceDialog: true });
    try {
      if (action === "export") {
        if (!state.snapshot?.manuscript) return;
        const path = await promptForExportPath(`${fileStem(document.path)} - Manuscript`, "markdown", "Export Manuscript Markdown");
        if (!path || !manuscriptMatchesOpenDocument(state.session)) return;
        const current = useDocumentStore.getState().snapshot?.manuscript;
        if (current) await writeTextFileAtPath(path, exportManuscriptMarkdown(current.contentJson));
        return;
      }
      if (action === "remove") {
        if (!state.snapshot?.manuscript || !await confirm("Remove the manuscript and all its passage links?", {
          title: "Remove Manuscript", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel",
        }) || !manuscriptMatchesOpenDocument(state.session)) return;
        updateSnapshot((snapshot) => ({ ...snapshot, manuscript: null }));
        showLayout("tree", "tree");
        return;
      }
      const path = await promptForMarkdownImportPath("Import Manuscript Markdown");
      if (!path) return;
      const parsed = parseManuscriptMarkdown(await readTextFileAtPath(path));
      if (!manuscriptMatchesOpenDocument(state.session)) return;
      const replacing = Boolean(useDocumentStore.getState().snapshot?.manuscript);
      if ((replacing || parsed.loss) && !await confirm(
        [replacing ? "Replace the manuscript? Replacement removes its existing passage links." : null, parsed.loss]
          .filter(Boolean).join("\n\n"), {
          title: "Import Manuscript Markdown", kind: "warning",
          okLabel: replacing ? "Replace" : "Import", cancelLabel: "Cancel",
        },
      )) return;
      if (!manuscriptMatchesOpenDocument(state.session)) return;
      updateSnapshot((snapshot) => ({ ...snapshot, manuscript: { id: manuscriptUuid(), contentJson: parsed.contentJson, passages: [] } }));
      preserveDocumentTreeExplorerContext();
      showLayout(splitFits ? "both" : "manuscript", "manuscript");
    } catch (error) {
      setNotice({
        tone: "error",
        message: error && typeof error === "object" && "message" in error ? String(error.message) : "Manuscript operation failed.",
      });
    } finally {
      manuscriptFileDialog.current = false;
      interaction.setState({ workspaceDialog: false });
    }
  }

  async function resolveSaveConflict(action: "copy" | "reload") {
    if (recovering || manuscriptFileDialog.current) return;
    const state = useDocumentStore.getState();
    if (!state.snapshot || !state.revisionConflict) return;
    const session = state.session;
    setRecovering(true);
    manuscriptFileDialog.current = true;
    interaction.setState({ workspaceDialog: true });
    try {
      if (action === "copy") {
        const path = await save({
          title: "Save Unsaved Work as a Separate Document",
          defaultPath: `${fileStem(document.path)} - Recovered.fable`,
          filters: [{ name: "Fablecraft documents", extensions: ["fable"] }],
        });
        const current = useDocumentStore.getState().snapshot;
        if (!path || !current || !manuscriptMatchesOpenDocument(session)) return;
        const result = await saveDocumentRecoveryCopy(ensureFableExtension(path), toEditableDocumentSnapshot(current));
        if (manuscriptMatchesOpenDocument(session)) {
          setNotice({ tone: "info", message: `Unsaved work copied to ${result.name}.` });
        }
        return;
      }
      if (!await confirm("Replace the unsaved work in this window with the latest saved revision?", {
        title: "Reload Latest Revision", kind: "warning", okLabel: "Reload", cancelLabel: "Cancel",
      })) return;
      const latest = await loadCurrentDocumentSnapshot();
      if (manuscriptMatchesOpenDocument(session) && latest.summary.path === document.path) hydrateSnapshot(latest);
    } catch (error) {
      setNotice({ tone: "error", message: error && typeof error === "object" && "message" in error
        ? String(error.message) : "Could not recover the document." });
    } finally {
      setRecovering(false);
      manuscriptFileDialog.current = false;
      interaction.setState({ workspaceDialog: false });
    }
  }

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => setWorkspaceWidth(element.clientWidth || window.innerWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (readOnly) return;
    const saved = savedWorkspaceLayout(document.documentId);
    setPresentation({ documentId: document.documentId, ...saved });
    activatePane(saved.layout === "manuscript" ? "manuscript" : "tree");
    presentationReady.current = false;
    hadManuscript.current = false;
    setLinkTarget(null);
    interaction.setState({ workspaceDialog: false });
    setRevealPassage(null);
  }, [document.documentId, readOnly]);

  useLayoutEffect(() => {
    if (!historyPreview) return;
    setPresentation((current) => ({ ...current, layout: historyPreview.pane }));
    interaction.setState({ workspacePane: historyPreview.pane });
    setActivePane(historyPreview.pane);
  }, [historyPreview?.pane]);

  useLayoutEffect(() => {
    if (historyPane) activatePane(historyPane);
  }, [historyPane]);

  useLayoutEffect(() => {
    if (historyPreview?.navigationRequest === undefined) return;
    if (showTree) stageRef.current?.focus({ preventScroll: true });
    else if (showManuscript) manuscriptRef.current?.focus();
  }, [historyPreview?.navigationRequest, showTree, showManuscript]);

  useLayoutEffect(() => {
    if (!historyPreview?.focus) return;
    const { cardId, passage, request } = historyPreview.focus;
    if (cardId) setActiveCardId(cardId);
    if (passage) setRevealPassage({ ...passage, request });
  }, [historyPreview?.focus, setActiveCardId]);

  useEffect(() => {
    historyPreview?.onCard(activeCardId);
  }, [activeCardId, historyPreview?.onCard]);

  useLayoutEffect(() => {
    if (readOnly || !activeSnapshot || presentation.documentId !== document.documentId) return;
    if (!presentationReady.current) {
      presentationReady.current = true;
      if (!manuscript && savedLayout !== "tree") showLayout("tree", "tree");
      else {
        const pane = savedLayout === "manuscript" ? "manuscript" : "tree";
        focusRequest.current = pane;
        activatePane(pane);
      }
    } else if (hadManuscript.current && !manuscript) {
      showLayout("tree", "tree");
    }
    hadManuscript.current = Boolean(manuscript);
    try {
      localStorage.setItem(`fablecraft.workspace.${document.documentId}`, JSON.stringify({
        layout: savedLayout, ratio: presentation.ratio,
      }));
    } catch { /* Layout preferences are optional. */ }
  }, [Boolean(activeSnapshot), Boolean(manuscript), presentation, document.documentId, readOnly]);

  useLayoutEffect(() => {
    if (!historyPaneRequest) return;
    if (historyPaneRequest.keepEditing) {
      const { pane } = historyPaneRequest;
      showLayout(savedLayout === "both" ? "both" : pane, pane);
      return;
    }
    if (historyPaneRequest.startEditing) {
      const { pane, cardId } = historyPaneRequest;
      preserveDocumentTreeExplorerContext();
      showLayout(savedLayout === "both" ? "both" : pane, pane);
      if (pane === "tree") {
        if (cardId) focusCardForEditing(cardId);
      } else {
        setMode("navigation");
      }
      return;
    }
    const pane = layout === "both" ? historyPaneRequest.pane : layout;
    focusRequest.current = pane;
    activatePane(pane);
  }, [historyPaneRequest]);

  useLayoutEffect(() => {
    interaction.setState({ workspaceSplitFits: splitFits });
    const requested = focusRequest.current;
    if (!requested || requested !== activePane) return;
    if (requested === "manuscript" && showManuscript && manuscriptRef.current) {
      manuscriptRef.current.focus();
    } else if (requested === "tree" && showTree) {
      const editor = mode === "editing" && stageRef.current?.querySelector<HTMLElement>(".ProseMirror[contenteditable=true]");
      if (editor instanceof HTMLElement) editor.focus({ preventScroll: true });
      else stageRef.current?.focus({ preventScroll: true });
    } else return;
    focusRequest.current = null;
  }, [presentation, activePane, showTree, showManuscript, Boolean(manuscript), Boolean(activeSnapshot), splitFits, historyPaneRequest]);

  useEffect(() => {
    return () => interaction.setState({ workspacePane: "tree", workspaceDialog: false });
  }, []);

  useEffect(() => {
    function workspaceBlocked() {
      if (readOnly) return true;
      const currentMode = useAppStore.getState().mode;
      return suspendKeyboard || pendingDeleteDocument || renamingDocumentPath ||
        interaction.getState().workspaceDialog ||
        currentMode === "search" || currentMode === "command";
    }

    function handlePaneKeys(event: KeyboardEvent) {
      if ((event.target instanceof Element && event.target.closest(".fc-history-timeline")) ||
        event.defaultPrevented || workspaceBlocked() || event.isComposing || event.keyCode === 229 ||
        manuscriptRef.current?.composing() || stageRef.current?.querySelector("[data-editor-composing=true]")) return;
      const apple = /Mac|iPhone|iPad/.test(navigator.platform);
      const direction = historyOpen ? null : paneShortcut(event, apple);
      if (direction !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) stepPane(direction);
        return;
      }
      if (activePane !== "manuscript") return;
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey &&
        event.key.toLowerCase() === "l" && !event.repeat &&
        (event.target as Element | null)?.closest(".fc-manuscript-editor") && startLinkTargetSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if ((apple ? event.metaKey : event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) redoEditing();
        else undoEditing();
      }
    }

    const unlisten = listenForFrontendMenuActions((action) => {
      if (workspaceBlocked() || manuscriptRef.current?.composing() || !activeSnapshot) return;
      if (action === "layout-tree") showLayout("tree", "tree");
      if (action === "layout-manuscript") {
        preserveDocumentTreeExplorerContext();
        showLayout("manuscript", "manuscript");
      }
      if (action === "layout-both") {
        if (!splitFits) setNotice({ tone: "info", message: "Widen the window to show Tree and Manuscript together." });
        else { preserveDocumentTreeExplorerContext(); showLayout("both"); }
      }
      if (action === "pane-left") stepPane(-1);
      if (action === "pane-right") stepPane(1);
      if (action === "write-manuscript") {
        preserveDocumentTreeExplorerContext();
        showLayout(showManuscript ? layout : splitFits ? "both" : "manuscript", "manuscript");
        manuscriptRef.current?.write();
      }
      if (action === "remove-manuscript") void manuscriptFileAction("remove");
      if (action === "import-manuscript-markdown") void manuscriptFileAction("import");
      if (action === "export-manuscript-markdown") void manuscriptFileAction("export");
      if (activePane !== "manuscript") return;
      if (action === "undo") undoEditing();
      if (action === "redo") redoEditing();
      if (action === "search") manuscriptRef.current?.search();
      if (action === "restore-manuscript-focus" && window.document.activeElement === window.document.body) manuscriptRef.current?.focus();
      if (action === "link-manuscript-passage") startLinkTargetSelection();
    });

    window.addEventListener("keydown", handlePaneKeys, true);
    return () => {
      unlisten();
      window.removeEventListener("keydown", handlePaneKeys, true);
    };
  });

  const selectedDirectoryEntry =
    explorerSelection.kind === "entry"
      ? directory?.entries.find((entry) => entry.path === explorerSelection.path) ?? null
      : explorerSelection.kind === "preview-entry"
        ? directory?.entries.find((entry) => entry.path === explorerSelection.parentPath) ?? null
        : explorerSelection.kind === "card" && explorerSelection.parentPath
          ? directory?.entries.find((entry) => entry.path === explorerSelection.parentPath) ?? null
      : null;
  const directoryEntries = (directory?.entries ?? []).filter((entry) => !deletedPathsRef.current.has(entry.path));
  const folderSiblingEntries = (parentDirectory?.entries ?? []).filter(
    (entry) => !deletedPathsRef.current.has(entry.path),
  );
  const activeFolderIndex = folderSiblingEntries.findIndex(
    (entry) => entry.path === directory?.folderPath,
  );
  const previewDirectoryEntries = (previewDirectory?.entries ?? []).filter((entry) => !deletedPathsRef.current.has(entry.path));
  const currentDocumentDirectoryEntry =
    directoryEntries.find((entry) => entry.path === directory?.currentDocumentPath) ?? null;
  const selectedPreviewEntry =
    explorerSelection.kind === "preview-entry"
      ? previewDirectoryEntries.find((entry) => entry.path === explorerSelection.path) ?? null
      : explorerSelection.kind === "card" && explorerSelection.documentPath
        ? previewDirectoryEntries.find((entry) => entry.path === explorerSelection.documentPath) ?? {
            kind: "document",
            name: fileNameFromPath(explorerSelection.documentPath),
            path: explorerSelection.documentPath,
          }
      : null;

  useEffect(() => {
    let cancelled = false;

    async function loadPreviewDirectory(path: string) {
      try {
        const nextPreviewDirectory = await listFableDirectory(path);

        if (!cancelled) {
          setPreviewDirectory(nextPreviewDirectory);
          setDirectoryLoadError(null);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setPreviewDirectory(null);
          setDirectoryLoadError(
            error instanceof Error ? error.message : "Could not read folder.",
          );
        }
      }
    }

    if (selectedDirectoryEntry?.kind === "folder") {
      void loadPreviewDirectory(selectedDirectoryEntry.path);
    } else {
      setPreviewDirectory(null);
    }

    return () => {
      cancelled = true;
    };
  }, [selectedDirectoryEntry?.kind, selectedDirectoryEntry?.path]);
  const contentsByCard = useMemo(() => new Map(activeSnapshot?.contents.map(({ cardId, contentJson }) => [cardId, contentJson])),
    [activeSnapshot?.contents]);
  const appearanceHeights = useMemo(() => {
    const heights = new Map<string, number>();
    return Object.fromEntries(layoutCards.map((card) => {
      const id = referenceLayout?.appearances.get(card.id)?.cardId ?? card.id;
      const height = cardHeights[cardHeightCacheKey(id)] ?? heights.get(id) ?? estimateRichCardHeight(
        contentsByCard.get(id) ?? EMPTY_EDITOR_DOCUMENT_JSON, uiMetrics, uiPreferences,
      );
      heights.set(id, height);
      return [card.id, height];
    }));
  }, [referenceLayout, contentsByCard, cardHeights, uiMetrics.cardHeight, uiMetrics.cardWidth, uiPreferences]);
  const selectedCard =
    activeSnapshot?.cards.find((card) => card.id === activeCardId) ?? null;
  const selectedCardContent =
    activeSnapshot && activeCardId
      ? cardContent(activeSnapshot, activeCardId)
      : null;
  const canCreateStructure = selectedCardContent
    ? canCreateCardsFromContent(selectedCardContent)
    : false;
  const isSelectedCardEmpty = selectedCardContent
    ? isContentEffectivelyEmpty(selectedCardContent)
    : true;
  const isFirstRootCard = selectedCard?.parentId === null && selectedCard.orderIndex === 0;
  const isOnlyCardInDocument = activeSnapshot?.cards.length === 1;
  const canLeaveEditing =
    !selectedCard || !isOnlyCardInDocument || !isSelectedCardEmpty;
  const cardById = new Map(
    (activeSnapshot?.cards ?? []).map((card) => [card.id, card]),
  );
  const isFirstRootCardId = (cardId: string) => {
    const card = cardById.get(cardId);

    return card?.parentId === null && card.orderIndex === 0;
  };
  const navigationEmptyPlaceholder =
    mode === "navigation" && isSelectedCardEmpty && !isFirstRootCard
      ? "empty card"
      : "";
  const activePlaceholder = isFirstRootCard
    ? "Your story starts here"
    : navigationEmptyPlaceholder;
  const overviewMetrics = {
    cardHeight: OVERVIEW_CARD_HEIGHT * OVERVIEW_SCALE,
    cardWidth: OVERVIEW_CARD_WIDTH * OVERVIEW_SCALE,
    spacing: OVERVIEW_SIBLING_GAP,
  };
  const layoutMetrics = isOverviewMode
    ? overviewMetrics
    : uiMetrics;
  const normalStageLayoutResult = useMemo(() =>
    activeAppearanceId && !isOverviewMode
      ? arrangeWritingStage(stageLayout(layoutCards, activeAppearanceId!, {
          cardHeight: uiMetrics.cardHeight,
          cardHeights: appearanceHeights,
          cardWidth: uiMetrics.cardWidth,
          spacing: uiMetrics.spacing,
          rememberedChildIds: layoutRememberedChildren,
        }), layoutCards, activeAppearanceId!, layoutRememberedChildren, workspaceViewportHeight, writingLayoutTokens)
      : { cards: [], emptyChildGap: null },
  [activeAppearanceId, isOverviewMode, layoutCards, appearanceHeights, uiMetrics.cardHeight, uiMetrics.cardWidth,
    uiMetrics.spacing, layoutRememberedChildren, workspaceViewportHeight]);
  const overviewLayoutResult = useMemo(() =>
    activeAppearanceId && isOverviewMode
      ? overviewTreeLayout(layoutCards, activeAppearanceId!, {
          cardHeight: overviewMetrics.cardHeight,
          cardWidth: overviewMetrics.cardWidth,
          columnGap: OVERVIEW_COLUMN_GAP,
          maxSiblingCenterGap: OVERVIEW_MAX_SIBLING_CENTER_GAP,
          preferredSiblingCenterGap: OVERVIEW_PREFERRED_SIBLING_CENTER_GAP,
          siblingGap: OVERVIEW_SIBLING_GAP,
        })
      : { cards: [], connectors: [] },
  [activeAppearanceId, isOverviewMode, layoutCards]);
  const stageCards = isOverviewMode
    ? overviewLayoutResult.cards
    : normalStageLayoutResult.cards;
  const visibleAncestorIds = new Set(
    activeSnapshot && activeCardId
      ? ancestorsOfCard(layoutCards, activeAppearanceId!).map((card) => card.id)
      : [],
  );
  const positionedCards = activeSnapshot
    ? stageCards.filter((position) => {
        if (isOverviewMode) return true;
        if (isFocusedMode) return position.isActive || Boolean(activeLayoutCard &&
          layoutCardById.get(position.cardId)?.parentId === activeLayoutCard.parentId);
        const depth = Math.round(position.x / (uiMetrics.cardWidth + uiMetrics.spacing));
        const card = layoutCardById.get(position.cardId);
        return depth >= writing.minimumDepth && depth <= writing.maximumDepth &&
          (position.isNeighborhood || visibleAncestorIds.has(position.cardId) ||
            (writing.columns === 4 && Boolean(card?.parentId && directChildren.has(card.parentId))));
      }).map((position) => ({
        ...position,
        x: position.x + (isOverviewMode ? 0 : writing.activeX),
        appearance: referenceLayout!.appearances.get(position.cardId)!,
        contentJson: contentsByCard.get(referenceLayout!.appearances.get(position.cardId)!.cardId) ?? EMPTY_EDITOR_DOCUMENT_JSON,
        parentId: layoutCardById.get(position.cardId)?.parentId ?? null,
      }))
    : [];
  const focusedNavigationDirections = isFocusedMode && !isExplorerSelectionActive && activeAppearanceId
    ? [
        { direction: "up", available: Boolean(previousCardInColumn(layoutCards, activeAppearanceId)), rotation: 270 },
        { direction: "down", available: Boolean(nextCardInColumn(layoutCards, activeAppearanceId)), rotation: 90 },
        { direction: "left", available: Boolean(parentCardId(layoutCards, activeAppearanceId) || (selectedCard?.parentId === null && directory)), rotation: 180 },
        { direction: "right", available: Boolean(preferredChildCardId(layoutCards, activeAppearanceId, layoutRememberedChildren)), rotation: 0 },
      ].filter((item) => item.available)
    : [];
  const columnWidth = uiMetrics.cardWidth + uiMetrics.spacing;
  const explorerCardWidth = Math.round(directoryMetrics.cardWidth / 2);
  const explorerGap = uiMetrics.spacing;
  const explorerColumnWidth = explorerCardWidth + explorerGap;
  const explorerToDocumentOffset =
    explorerCardWidth / 2 + directoryMetrics.cardWidth / 2 + explorerGap;
  const shouldShowDocumentTree = !isExplorerSelectionActive;
  const visibleTreeCards = uiPreferences.neighborCards === "hidden" && !isOverviewMode && !isFocusedMode
    ? positionedCards.filter((card) => card.isActive)
    : positionedCards;
  const currentDocumentName = directory
    ? documentNameWithoutExtension(directory.currentDocumentPath)
    : documentNameWithoutExtension(document.name);
  const parentFolderName = directory?.parentFolderPath
    ? fileNameFromPath(directory.parentFolderPath)
    : null;
  const selectedRenamableDocument =
    explorerSelection.kind === "current-document" && directory
      ? {
          name: currentDocumentName,
          path: directory.currentDocumentPath,
        }
      : explorerSelection.kind === "entry" && selectedDirectoryEntry?.kind === "document"
        ? {
            name: explorerLabelForEntry(selectedDirectoryEntry),
            path: selectedDirectoryEntry.path,
          }
        : explorerSelection.kind === "preview-entry" && selectedPreviewEntry?.kind === "document"
          ? {
              name: explorerLabelForEntry(selectedPreviewEntry),
            path: selectedPreviewEntry.path,
          }
        : null;
  const selectedDeletableDocument = selectedRenamableDocument;
  const isRenamingSelectedDocument =
    Boolean(
      selectedRenamableDocument &&
      renamingDocumentPath === selectedRenamableDocument.path,
    );
  const explorerRowGap = uiMetrics.cardHeight + uiMetrics.spacing;
  const explorerEntryY = (index: number) => {
    if (explorerSelection.kind === "folder") {
      return (index - rememberedEntryIndex(directoryEntries, directory?.folderPath)) * explorerRowGap;
    }

    if (explorerSelection.kind === "entry" || explorerSelection.kind === "current-document") {
      const activeIndex =
        explorerSelection.kind === "current-document"
          ? directoryEntries.findIndex((entry) => entry.path === directory?.currentDocumentPath)
          : selectedEntryIndex();
      return (index - Math.max(0, activeIndex)) * explorerRowGap;
    }

    return (index - (directoryEntries.length - 1) / 2) * explorerRowGap;
  };
  const previewEntryY = (index: number) => {
    if (explorerSelection.kind === "entry") {
      return (index - rememberedEntryIndex(previewDirectoryEntries, selectedDirectoryEntry?.path)) * explorerRowGap;
    }

    if (
      explorerSelection.kind === "preview-entry" ||
      (explorerSelection.kind === "card" && selectedPreviewEntry)
    ) {
      const activeIndex = selectedPreviewEntryIndex();
      return (index - Math.max(0, activeIndex)) * explorerRowGap;
    }

    return (index - (previewDirectoryEntries.length - 1) / 2) *
      explorerRowGap;
  };
  const shouldRenderDirectoryEntryColumn =
    explorerSelection.kind === "folder" ||
    explorerSelection.kind === "entry" ||
    (explorerSelection.kind === "current-document" && Boolean(currentDocumentDirectoryEntry));
  const shouldRenderCurrentDocumentFallback =
    explorerSelection.kind === "current-document" && !currentDocumentDirectoryEntry;
  const shouldRenderPreviewEntryColumn =
    selectedDirectoryEntry?.kind === "folder" &&
    (explorerSelection.kind === "entry" ||
      explorerSelection.kind === "preview-entry");
  const explorerPanLimit = directoryEntries.reduce(
    (limit, _entry, index) =>
      Math.max(limit, Math.abs(explorerEntryY(index)) + uiMetrics.cardHeight),
    uiMetrics.cardHeight,
  );
  const previewPanLimit = previewDirectoryEntries.reduce(
    (limit, _entry, index) =>
      Math.max(limit, Math.abs(previewEntryY(index)) + uiMetrics.cardHeight),
    uiMetrics.cardHeight,
  );
  const emptyChildGap = isOverviewMode || isFocusedMode || writing.maximumDepth < 1 || !normalStageLayoutResult.emptyChildGap
    ? null : { ...normalStageLayoutResult.emptyChildGap, x: normalStageLayoutResult.emptyChildGap.x + writing.activeX };
  const overviewConnectors = isOverviewMode ? overviewLayoutResult.connectors : [];
  const stagePanLimit = positionedCards.reduce(
    (limits, card) => ({
      x: Math.max(limits.x, Math.abs(card.x) + layoutMetrics.cardWidth),
      y: Math.max(limits.y, Math.abs(card.y) + card.height),
    }),
    { x: layoutMetrics.cardWidth, y: layoutMetrics.cardHeight },
  );
  if (directory && !isOverviewMode && isExplorerSelectionActive) {
    stagePanLimit.x = Math.max(
      stagePanLimit.x,
      explorerToDocumentOffset +
        columnWidth +
        explorerColumnWidth * 3,
    );
    stagePanLimit.y = Math.max(
      stagePanLimit.y,
      explorerPanLimit,
      previewPanLimit,
      folderSiblingEntries.length * explorerRowGap,
    );
  }
  if (emptyChildGap && !isOverviewMode) {
    stagePanLimit.x = Math.max(stagePanLimit.x, Math.abs(emptyChildGap.x) + layoutMetrics.cardWidth);
    stagePanLimit.y = Math.max(stagePanLimit.y, Math.abs(emptyChildGap.y) + emptyChildGap.height);
  }
  const overviewScale = isOverviewMode ? OVERVIEW_SCALE : 1;
  const isEditingSelectedCard = mode === "editing";
  const cardNumbers = useMemo(() => activeSnapshot ? buildCardNumberMap(activeSnapshot) : {}, [activeSnapshot?.cards]);
  const descendantCounts = useMemo(() => activeSnapshot ? buildDescendantCountMap(activeSnapshot.cards) : {}, [activeSnapshot?.cards]);
  const highlightedOverviewConnectorChildIds = new Set(
    activeSnapshot && activeCardId && isOverviewMode
      ? [
          activeAppearanceId!,
          ...ancestorsOfCard(layoutCards, activeAppearanceId!).map(
            (ancestor) => ancestor.id,
          ),
        ]
      : [],
  );
  const highlightedOverviewConnectorParentIds = new Set(
    activeSnapshot && activeCardId && isOverviewMode
      ? [
          activeAppearanceId!,
          ...descendantCardIds(layoutCards, activeAppearanceId!),
        ]
      : [],
  );
  const activeHorizontalPadding = 33;
  const activeTopPadding = 40;
  const activeBottomPadding = 23;

  function focusCardForEditing(
    nextCardId: string | null,
    placement: EditorFocusPlacement | null = "end",
    textInput: string | null = null,
  ) {
    if (!nextCardId || !(historyPreview?.snapshot ?? useDocumentStore.getState().snapshot)?.cards.some((card) => card.id === nextCardId)) {
      return false;
    }

    setActiveCardId(nextCardId);
    if (readOnly) return true;
    setPendingEditorFocusPlacement(placement);
    setPendingEditorTextInput(textInput);
    setMode("editing");
    return true;
  }

  async function openDirectory(path: string) {
    try {
      const nextDirectory = await listFableDirectory(path);
      setDirectory(nextDirectory);
      setPreviewDirectory(null);
      setDirectoryLoadError(null);
      selectExplorer({ kind: "folder" });
      setMode("navigation");
    } catch (error) {
      console.error(error);
      setDirectoryLoadError(
        error instanceof Error ? error.message : "Could not read folder.",
      );
    }
  }

  function selectFolderSibling(entry: FableDirectoryEntry) {
    if (entry.path === directory?.folderPath) {
      return;
    }
    if (entry.kind === "folder") {
      void openDirectory(entry.path);
    } else if (parentDirectory) {
      setDirectory(parentDirectory);
      setPreviewDirectory(null);
      selectExplorer({ kind: "entry", path: entry.path });
      setMode("navigation");
    }
  }

  async function createDocumentInCurrentDirectory() {
    if (!directory || createInFlightRef.current) {
      return;
    }

    const previewParentPath = explorerSelection.kind === "preview-entry"
      ? explorerSelection.parentPath
      : null;
    const targetPath = previewParentPath ?? directory.folderPath;
    createInFlightRef.current = true;
    try {
      // Read before creating so a failed refresh cannot hide a successfully created file.
      const listing = await listFableDirectory(targetPath);
      const nextDocument = await createUntitledDocumentInDirectory(targetPath);
      deletedPathsRef.current.delete(nextDocument.path);
      const nextListing: FableDirectory = {
        ...listing,
        entries: [...listing.entries, {
          kind: "document" as const,
          name: fileNameFromPath(nextDocument.path),
          path: nextDocument.path,
        }].sort((left, right) => {
          if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
          const leftName = left.name.toLowerCase();
          const rightName = right.name.toLowerCase();
          return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
        }),
      };
      if (previewParentPath) {
        setPreviewDirectory(nextListing);
        selectExplorer({ kind: "preview-entry", parentPath: previewParentPath, path: nextDocument.path });
      } else {
        setDirectory(nextListing);
        selectExplorer({ kind: "entry", path: nextDocument.path });
      }
      newlyCreatedDocumentPathRef.current = nextDocument.path;
      setRenamingDocumentPath(nextDocument.path);
      setRenameDraft(documentNameWithoutExtension(nextDocument.name));
      setDirectoryLoadError(null);
      setMode("navigation");
      onDocumentCreated?.(nextDocument);
    } catch (error) {
      console.error(error);
      setDirectoryLoadError(
        error instanceof Error ? error.message : "Could not create document.",
      );
    } finally {
      createInFlightRef.current = false;
    }
  }

  function startRenamingSelectedDocument() {
    if (!selectedRenamableDocument) {
      return false;
    }

    setRenamingDocumentPath(selectedRenamableDocument.path);
    setRenameDraft(selectedRenamableDocument.name);
    setMode("navigation");
    setStageOffset({ x: 0, y: 0 });
    return true;
  }

  function cancelRename() {
    newlyCreatedDocumentPathRef.current = null;
    setRenamingDocumentPath(null);
    setRenameDraft("");
  }

  function startDeletingSelectedDocument() {
    if (!selectedDeletableDocument) {
      return false;
    }

    setDocumentDeleteError(null);
    setSelectedDeleteDocumentAction("cancel");
    setPendingDeleteDocument(selectedDeletableDocument);
    setMode("navigation");
    return true;
  }

  function cancelDeleteDocument() {
    setDocumentDeleteError(null);
    setPendingDeleteDocument(null);
  }

  async function refreshDirectoryAfterRename(
    previousPath: string,
    nextDocument: DocumentSummary,
  ) {
    const nextDirectory = directory
      ? await listFableDirectory(directory.folderPath)
      : await listCurrentDocumentDirectory();
    setDirectory(nextDirectory);

    if (previewDirectory) {
      const previewFolderPath = previewDirectory.folderPath;
      setPreviewDirectory(await listFableDirectory(previewFolderPath));
    }

    if (explorerSelection.kind === "entry" && explorerSelection.path === previousPath) {
      selectExplorer({ kind: "entry", path: nextDocument.path });
    } else if (
      explorerSelection.kind === "preview-entry" &&
      explorerSelection.path === previousPath
    ) {
      selectExplorer({
        kind: "preview-entry",
        parentPath: explorerSelection.parentPath,
        path: nextDocument.path,
      });
    } else if (
      explorerSelection.kind === "card" &&
      explorerSelection.documentPath === previousPath
    ) {
      selectExplorer({
        ...explorerSelection,
        documentPath: nextDocument.path,
      });
    } else {
      setStageOffset({ x: 0, y: 0 });
    }
  }

  async function commitRename() {
    if (!renamingDocumentPath) {
      return;
    }

    const previousPath = renamingDocumentPath;
    if (previousPath === newlyCreatedDocumentPathRef.current && !renameDraft.trim()) {
      cancelRename();
      return;
    }

    try {
      const nextDocument = await renameFableDocument(previousPath, renameDraft);
      deletedPathsRef.current.delete(nextDocument.path);
      cancelRename();
      setDirectoryLoadError(null);
      await refreshDirectoryAfterRename(previousPath, nextDocument);

      if (previousPath === document.path) {
        updateSummary(nextDocument);
        onDocumentRenamed?.(nextDocument, previousPath);
      }
    } catch (error) {
      console.error(error);
      setDirectoryLoadError(
        error instanceof Error ? error.message : "Could not rename document.",
      );
    }
  }

  async function refreshDirectoryAfterDelete(deletedPath: string) {
    const nextDirectory = directory
      ? await listFableDirectory(directory.folderPath)
      : await listCurrentDocumentDirectory();
    setDirectory(nextDirectory);

    if (previewDirectory) {
      const previewFolderPath = previewDirectory.folderPath;
      setPreviewDirectory(await listFableDirectory(previewFolderPath));
    }

    if (explorerSelection.kind === "entry" && explorerSelection.path === deletedPath) {
      selectExplorer({ kind: "folder" });
      return;
    }

    if (
      explorerSelection.kind === "preview-entry" &&
      explorerSelection.path === deletedPath
    ) {
      selectExplorer({
        kind: "entry",
        path: explorerSelection.parentPath,
      });
      return;
    }

    if (
      explorerSelection.kind === "card" &&
      explorerSelection.documentPath === deletedPath &&
      explorerSelection.parentPath
    ) {
      selectExplorer({
        kind: "entry",
        path: explorerSelection.parentPath,
      });
      return;
    }

    setStageOffset({ x: 0, y: 0 });
  }

  async function commitDeleteDocument() {
    if (!pendingDeleteDocument || deleteInFlightRef.current) {
      return;
    }

    deleteInFlightRef.current = true;
    const deletedDocument = pendingDeleteDocument;

    try {
      await deleteFableDocument(deletedDocument.path);
      deletedPathsRef.current.add(deletedDocument.path);
      setPendingDeleteDocument(null);
      setDocumentDeleteError(null);

      onDocumentDeleted?.(deletedDocument.path);
      if (deletedDocument.path === document.path) {
        return;
      }

      await refreshDirectoryAfterDelete(deletedDocument.path);
      setNotice({
        tone: "info",
        message: `Moved "${deletedDocument.name}" to Trash.`,
      });
    } catch (error) {
      console.error(error);
      const details = error && typeof error === "object" && "details" in error
        && typeof error.details === "string" ? error.details : null;
      setDocumentDeleteError(
        (error && typeof error === "object" && "message" in error
          ? String(error.message) : "Could not move document to Trash."
        ) + (details ? `\n\n${details}` : ""),
      );
    } finally {
      deleteInFlightRef.current = false;
    }
  }

  function activateDeleteDialogAction(action: DeleteDocumentAction) {
    if (action === "cancel") {
      cancelDeleteDocument();
      return;
    }

    void commitDeleteDocument();
  }

  function firstRootCardId() {
    return activeSnapshot?.cards
      .filter((card) => card.parentId === null)
      .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id))[0]?.id ?? null;
  }

  function rememberedEntryIndex(entries: FableDirectoryEntry[], folderPath?: string) {
    const rememberedPath = rememberedChildIds[`folder:${folderPath}`];
    return Math.max(0, entries.findIndex((entry) => entry.path === rememberedPath));
  }

  function preferredRootCardId() {
    const rememberedId = rememberedChildIds[`document:${document.path}`];
    return activeSnapshot?.cards.some((card) => card.id === rememberedId && card.parentId === null)
      ? rememberedId
      : firstRootCardId();
  }

  function selectEntryAtIndex(index: number) {
    const entry = directoryEntries[index];

    if (!entry) {
      return false;
    }

    selectExplorer({ kind: "entry", path: entry.path });
    setMode("navigation");
    return true;
  }

  function selectedEntryIndex() {
    if (explorerSelection.kind !== "entry") {
      return -1;
    }

    return directoryEntries.findIndex((entry) => entry.path === explorerSelection.path);
  }

  function selectPreviewEntryAtIndex(index: number) {
    if (!selectedDirectoryEntry) {
      return false;
    }

    const entry = previewDirectoryEntries[index];

    if (!entry) {
      return false;
    }

    selectExplorer({
      kind: "preview-entry",
      parentPath: selectedDirectoryEntry.path,
      path: entry.path,
    });
    setMode("navigation");
    return true;
  }

  async function selectPreferredChildOfFolder(entry: FableDirectoryEntry) {
    if (entry.kind !== "folder") {
      return false;
    }

    try {
      const nextPreviewDirectory =
        previewDirectory?.folderPath === entry.path
          ? previewDirectory
          : await listFableDirectory(entry.path);
      const visibleEntries = nextPreviewDirectory.entries.filter((child) => !deletedPathsRef.current.has(child.path));
      const preferredChild = visibleEntries[rememberedEntryIndex(visibleEntries, entry.path)];

      setPreviewDirectory(nextPreviewDirectory);

      if (!preferredChild) {
        await openDirectory(entry.path);
        return true;
      }

      selectExplorer({
        kind: "preview-entry",
        parentPath: entry.path,
        path: preferredChild.path,
      });
      setMode("navigation");
      return true;
    } catch (error) {
      console.error(error);
      setDirectoryLoadError(
        error instanceof Error ? error.message : "Could not read folder.",
      );
      return false;
    }
  }

  function selectedPreviewEntryIndex() {
    if (explorerSelection.kind === "preview-entry") {
      return previewDirectoryEntries.findIndex((entry) => entry.path === explorerSelection.path);
    }

    if (explorerSelection.kind === "card" && explorerSelection.documentPath) {
      return previewDirectoryEntries.findIndex(
        (entry) => entry.path === explorerSelection.documentPath,
      );
    }

    return -1;
  }

  async function activateExplorerEntry(entry: FableDirectoryEntry | null) {
    if (!entry) {
      return false;
    }

    if (entry.kind === "folder") {
      await openDirectory(entry.path);
      return true;
    }

    if (entry.path === document.path) {
      selectExplorer({ kind: "card" });
      const rootId = preferredRootCardId();

      if (rootId) {
        setActiveCardId(rootId);
      }
      return true;
    }

    await onOpenDocumentPath?.(entry.path);
    return true;
  }

  function preserveDocumentTreeExplorerContext() {
    setExplorerSelection((currentSelection) =>
      currentSelection.kind === "card" ? currentSelection : { kind: "card" },
    );
    setStageOffset({ x: 0, y: 0 });
  }

  function selectExplorer(selection: ExplorerSelection) {
    setExplorerSelection(selection);
    setStageOffset({ x: 0, y: 0 });
  }

  function renamePropsForDocument(path: string) {
    if (renamingDocumentPath !== path) {
      return {};
    }

    return {
      isRenaming: true,
      onRenameCancel: cancelRename,
      onRenameCommit: () => {
        void commitRename();
      },
      onRenameDraftChange: setRenameDraft,
      renameDraft,
      renameInputRef,
    };
  }

  function createRelativeCard(direction: "before" | "after" | "child") {
    if (isReferenceView) setActiveCardId(activeCardId);
    if (!selectedCard || !selectedCardContent || !canCreateCardsFromContent(selectedCardContent)) {
      return false;
    }

    const newCardId = randomId("card");
    applyNavigationChange((snapshotToChange) => {
      if (direction === "before") {
        return createSiblingBefore(snapshotToChange, selectedCard.id, newCardId);
      }

      if (direction === "child") {
        return createChildCard(snapshotToChange, selectedCard.id, newCardId);
      }

      return createSiblingAfter(snapshotToChange, selectedCard.id, newCardId);
    });

    return focusCardForEditing(newCardId, "end");
  }

  function openCardLink(cardId: string) {
    if (!(historyPreview?.snapshot ?? useDocumentStore.getState().snapshot)?.cards.some((card) => card.id === cardId)) return;
    preserveDocumentTreeExplorerContext();
    setActiveCardId(cardId);
    setPendingEditorFocusPlacement(null);
    setPendingEditorTextInput(null);
    setMode("navigation");
  }

  function openAnchoredChild(sourceCardId: string, childId: string) {
    const snapshot = historyPreview?.snapshot ?? useDocumentStore.getState().snapshot;
    if (!snapshot?.cards.some((card) => card.id === childId && card.parentId === sourceCardId)) return;
    preserveDocumentTreeExplorerContext();
    rememberChild(sourceCardId, childId);
    focusCardForEditing(childId);
  }

  function createAnchoredChild(contentForChild: (childId: string) => string) {
    if (!selectedCard || !canCreateStructure) return;
    const sourceCardId = selectedCard.id;
    const childId = randomId("card");
    updateSnapshot((snapshot) => replaceCardContent(
      createChildCard(snapshot, sourceCardId, childId),
      { cardId: sourceCardId, contentJson: contentForChild(childId) },
    ));
    rememberChild(sourceCardId, childId);
    focusCardForEditing(childId);
  }

  function createParentLevel() {
    if (isReferenceView) setActiveCardId(activeCardId);
    if (!selectedCard || !selectedCardContent || !canCreateCardsFromContent(selectedCardContent)) {
      return false;
    }

    const newCardId = randomId("card");
    wrappedParentSourceChildRef.current[newCardId] = selectedCard.id;
    applyNavigationChange((snapshotToChange) =>
      wrapLevelInParent(snapshotToChange, selectedCard.id, newCardId),
    );
    return focusCardForEditing(newCardId, "end");
  }

  function handleDeleteCurrentCard(cardId: string) {
    if (!activeSnapshot) {
      return false;
    }

    if (activeSnapshot.cards.length <= 1) {
      updateSnapshot((snapshotToChange) =>
        replaceCardContent(snapshotToChange, {
          cardId,
          contentJson: EMPTY_EDITOR_DOCUMENT_JSON,
        }),
      );
      return true;
    }

    const fallbackCardId = fallbackCardIdAfterDelete(activeSnapshot, cardId);
    applyNavigationChange((snapshotToChange) =>
      deleteCardSubtree(snapshotToChange, cardId),
    );
    setActiveCardId(fallbackCardId);
    setPendingEditorFocusPlacement(null);
    setPendingEditorTextInput(null);
    return true;
  }

  function handleMergeCurrentCard(cardId: string, direction: "up" | "down") {
    if (isReferenceView) setActiveCardId(activeCardId);
    applyNavigationChange((snapshotToChange) =>
      direction === "up"
        ? mergeCardWithPreviousSibling(snapshotToChange, cardId)
        : mergeCardWithNextSibling(snapshotToChange, cardId),
    );
    return focusCardForEditing(cardId, "end");
  }

  function writeCardClipboardPayload(
    event: ClipboardEvent,
    payload: CardClipboardPayload,
  ) {
    const payloadJson = JSON.stringify(payload);
    const fallbackText = encodeCardClipboardPayload(payload);

    event.clipboardData?.setData(CARD_CLIPBOARD_MIME_TYPE, payloadJson);
    event.clipboardData?.setData("text/plain", fallbackText);
    cardClipboardFallbackRef.current = {
      payload,
      text: fallbackText,
    };
  }

  function readCardClipboardPayload(event: ClipboardEvent) {
    const clipboardData = event.clipboardData;
    const mimePayload = clipboardData?.getData(CARD_CLIPBOARD_MIME_TYPE) ?? "";
    const textPayload = clipboardData?.getData("text/plain") ?? "";
    const decodedPayload =
      decodeCardClipboardPayload(mimePayload) ??
      decodeCardClipboardPayload(textPayload);

    if (decodedPayload) {
      return decodedPayload;
    }

    const fallback = cardClipboardFallbackRef.current;

    if (!clipboardData && fallback) {
      return fallback.payload;
    }

    if (fallback && textPayload === fallback.text) {
      return fallback.payload;
    }

    return null;
  }

  function canHandleCardClipboard(allowEmptyEditingTarget = false) {
    const currentSnapshot = useDocumentStore.getState().snapshot;
    const isEmptyEditingTarget = allowEmptyEditingTarget && mode === "editing" &&
      Boolean(currentSnapshot && activeCardId &&
        isContentEffectivelyEmpty(cardContent(currentSnapshot, activeCardId)) &&
        !currentSnapshot.cards.some((card) => card.parentId === activeCardId));

    return (
      !readOnly && !suspendKeyboard &&
      interaction.getState().workspacePane === "tree" &&
      !interaction.getState().workspaceDialog &&
      !pendingDeleteDocument &&
      (mode === "navigation" || isEmptyEditingTarget) &&
      explorerSelection.kind === "card" &&
      Boolean(activeSnapshot && activeCardId)
    );
  }

  function handleFrontendMenuAction(action: NativeMenuAction) {
    if (readOnly) return;
    if (interaction.getState().workspacePane !== "tree" || interaction.getState().workspaceDialog) return;
    if (
      !activeSnapshot ||
      !activeCardId
    ) {
      return;
    }

    if (action === "zoom-in" || action === "zoom-out" || action.startsWith("view-")) {
      if (suspendKeyboard || mode === "search") return;
      if (action === "zoom-in") zoomView(1);
      else if (action === "zoom-out") zoomView(-1);
      else if (action === "view-wide-lens") changeViewMode("wide-lens");
      else if (action === "view-normal") changeViewMode("normal");
      else if (action === "view-focused") changeViewMode("focused");
      return;
    }

    if (
      suspendKeyboard ||
      mode === "search" ||
      mode === "command"
    ) {
      return;
    }

    if (action === "undo") {
      if (mode !== "editing") undoNavigation();
      return;
    }

    if (action === "redo") {
      if (mode !== "editing") redoNavigation();
      return;
    }

    if (isReferenceView) {
      if (activeAppearance?.missing || (isAliasCard && (action === "shift-up" || action === "shift-down"))) return;
      if (["merge-with-above", "merge-below", "shift-up", "shift-down", "create-child", "create-parent", "create-above", "create-below"].includes(action)) {
        setActiveCardId(activeCardId);
      }
    }

    if (action === "merge-with-above") {
      handleMergeCurrentCard(activeCardId, "up");
      return;
    }

    if (action === "merge-below") {
      handleMergeCurrentCard(activeCardId, "down");
      return;
    }

    if (action === "shift-up") {
      applyNavigationChange((snapshotToChange) =>
        moveCardWithinParent(snapshotToChange, activeCardId, -1),
      );
      return;
    }

    if (action === "shift-down") {
      applyNavigationChange((snapshotToChange) =>
        moveCardWithinParent(snapshotToChange, activeCardId, 1),
      );
      return;
    }

    if (action === "create-child") {
      createRelativeCard("child");
      return;
    }

    if (action === "create-parent") {
      createParentLevel();
      return;
    }

    if (action === "create-above") {
      createRelativeCard("before");
      return;
    }

    if (action === "create-below") {
      createRelativeCard("after");
      return;
    }

  }

  useEffect(() => {
    if (!activeSnapshot) {
      return;
    }

    if (referencePath) {
      const requestedId = referenceLayout?.activeId;
      const resolved = requestedId ? referenceLayout?.appearances.get(requestedId) : undefined;
      if (resolved && (resolved.cardId !== activeCardId || JSON.stringify(resolved.path) !== JSON.stringify(referencePath))) {
        setActiveAppearance(resolved.path);
      }
      return;
    }
    const selectedId = readOnly ? interaction.getState().activeCardId : activeCardId;
    const nextActiveCardId = selectedId && activeSnapshot.cards.some((card) => card.id === selectedId)
      ? selectedId : activeSnapshot.cards.find((card) => card.parentId === null)?.id ?? null;
    if (nextActiveCardId !== selectedId) setActiveCardId(nextActiveCardId);
  }, [activeCardId, activeSnapshot, referencePath, setActiveCardId, setActiveAppearance]);

  useLayoutEffect(() => {
    const previousCenterTarget = previousCenterTargetRef.current;
    const centerTargetChanged =
      previousCenterTarget !== null &&
      (previousCenterTarget.activeCardId !== activeCardId ||
        previousCenterTarget.appearanceId !== activeAppearanceId ||
        previousCenterTarget.documentId !== document.documentId);

    previousCenterTargetRef.current = {
      activeCardId,
      appearanceId: activeAppearanceId,
      documentId: document.documentId,
    };

    if (centerTargetChanged) {
      wheelPanSuppressedUntilRef.current =
        Date.now() + RECENTER_WHEEL_SUPPRESSION_MS;
    }

    setStageOffset({ x: 0, y: 0 });
  }, [activeCardId, activeAppearanceId, document.documentId]);

  useCardNavigationMotion(
    stageRef,
    document.documentId,
    viewMode,
    shouldShowDocumentTree && mode === "navigation" ? activeAppearanceId : null,
    visibleTreeCards,
    stageOffset,
    overviewConnectorsRef,
  );

  useEffect(() => {
    if (!readOnly) setViewMode("normal");
  }, [document.documentId, readOnly]);

  useEffect(() => {
    onTreeViewMode?.(viewMode);
  }, [onTreeViewMode, viewMode]);

  useEffect(() => {
    function updateViewportHeight() {
      setWorkspaceViewportHeight(stageRef.current?.clientHeight || viewportHeight());
      setWorkspaceViewportWidth(stageRef.current?.clientWidth || window.innerWidth);
    }

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    const observer = new ResizeObserver(updateViewportHeight);
    if (stageRef.current) observer.observe(stageRef.current);

    return () => {
      window.removeEventListener("resize", updateViewportHeight);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    setCardHeights({});
  }, [
    document.documentId,
    uiMetrics.cardHeight,
    uiMetrics.cardWidth,
    uiPreferences.font,
    uiPreferences.lineHeight,
    uiPreferences.textSize,
  ]);

  useEffect(() => {
    if (!renamingDocumentPath) {
      return;
    }

    if (selectedRenamableDocument?.path !== renamingDocumentPath) {
      newlyCreatedDocumentPathRef.current = null;
      setRenamingDocumentPath(null);
      setRenameDraft("");
    }
  }, [renamingDocumentPath, selectedRenamableDocument?.path]);

  useEffect(() => {
    if (!renamingDocumentPath) {
      return;
    }

    const input = renameInputRef.current;
    input?.focus();
    input?.select();
  }, [renamingDocumentPath]);

  useEffect(() => {
    if (!pendingDeleteDocument) {
      return;
    }

    const button =
      selectedDeleteDocumentAction === "cancel"
        ? cancelDeleteButtonRef.current
        : confirmDeleteButtonRef.current;
    button?.focus();
  }, [pendingDeleteDocument, selectedDeleteDocumentAction]);

  useEffect(() => {
    if (!pendingDeleteDocument) {
      return;
    }

    function handleDeleteDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelDeleteDocument();
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedDeleteDocumentAction("cancel");
        return;
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedDeleteDocumentAction("delete");
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        activateDeleteDialogAction(selectedDeleteDocumentAction);
      }
    }

    window.addEventListener("keydown", handleDeleteDialogKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleDeleteDialogKeyDown, true);
    };
  }, [pendingDeleteDocument, selectedDeleteDocumentAction]);

  useLayoutEffect(() => {
    if (!activeCardId || isOverviewMode) {
      return;
    }

    const cardElement = activeCardShellRef.current;

    if (!cardElement) {
      return;
    }

    const initialHeight = measuredLayoutHeight(cardElement);
    if (initialHeight > 0) {
      updateCardHeight(activeCardId, initialHeight, true);
    }

    const observer = new ResizeObserver(() => {
      const nextHeight = measuredLayoutHeight(cardElement);

      if (nextHeight && nextHeight > 0) {
        updateCardHeight(activeCardId, nextHeight, true);
      }
    });

    observer.observe(cardElement);

    return () => {
      observer.disconnect();
    };
  }, [activeCardId, isOverviewMode, mode, uiMetrics.cardHeight]);

  useEffect(() => {
    setStageOffset((currentOffset) => ({
      x: clampStageOffset(currentOffset.x, stagePanLimit.x),
      y: clampStageOffset(currentOffset.y, stagePanLimit.y),
    }));
  }, [stagePanLimit.x, stagePanLimit.y]);

  function unwrapEmptyCardWithChildren() {
    if (!activeSnapshot || !activeCardId || !selectedCard) {
      return null;
    }

    const hasChildren = activeSnapshot.cards.some(
      (card) => card.parentId === activeCardId,
    );

    if (!hasChildren || !isContentEffectivelyEmpty(cardContent(activeSnapshot, activeCardId))) {
      return null;
    }

    const fallbackCardId =
      wrappedParentSourceChildRef.current[selectedCard.id] ??
      firstChildCardId(activeSnapshot.cards, selectedCard.id);

    applyNavigationChange((snapshotToChange) =>
      unwrapCard(snapshotToChange, selectedCard.id),
    );
    delete wrappedParentSourceChildRef.current[selectedCard.id];

    return fallbackCardId;
  }

  function deleteEmptyLeafCard(fallbackCardId: string | null) {
    if (!activeSnapshot || !activeCardId || !selectedCard) {
      return false;
    }

    const hasChildren = activeSnapshot.cards.some(
      (card) => card.parentId === activeCardId,
    );

    if (
      hasChildren ||
      activeSnapshot.cards.length <= 1 ||
      !isContentEffectivelyEmpty(cardContent(activeSnapshot, activeCardId))
    ) {
      return false;
    }

    applyNavigationChange((currentSnapshot) =>
      deleteCardSubtree(currentSnapshot, activeCardId),
    );
    setActiveCardId(fallbackCardId);

    return true;
  }

  function abandonEmptyCard(fallbackCardId: string | null) {
    const unwrappedFallbackCardId = unwrapEmptyCardWithChildren();

    if (unwrappedFallbackCardId) {
      setActiveCardId(unwrappedFallbackCardId);
      return unwrappedFallbackCardId;
    }

    if (deleteEmptyLeafCard(fallbackCardId)) {
      return fallbackCardId;
    }

    return activeCardId;
  }

  function trimCardBeforeExit(cardId: string | null) {
    if (!cardId) {
      return;
    }

    updateSnapshot((snapshotToChange) => {
      const currentContentJson = cardContent(snapshotToChange, cardId);
      const trimmedContentJson =
        trimTrailingEmptyParagraphs(currentContentJson);

      if (trimmedContentJson === currentContentJson) {
        return snapshotToChange;
      }

      return replaceCardContent(snapshotToChange, {
        cardId,
        contentJson: trimmedContentJson,
      });
    });
  }

  function leaveEditingMode() {
    if (!activeSnapshot || !activeCardId || !selectedCard) {
      setMode("navigation");
      return;
    }

    const nextActiveCardId = abandonEmptyCard(
      fallbackCardIdAfterEmptyAbandon(activeSnapshot, activeCardId),
    );

    if (nextActiveCardId === activeCardId) {
      trimCardBeforeExit(activeCardId);
    }

    setMode("navigation");
  }

  function navigateFromEditing(nextCardId: string | null, placement: EditorFocusPlacement) {
    if (!nextCardId || !activeSnapshot || !activeCardId) {
      return false;
    }

    const fallbackCardId = fallbackCardIdAfterDelete(activeSnapshot, activeCardId);
    const cardIdToFocus = isSelectedCardEmpty
      ? abandonEmptyCard(nextCardId)
      : nextCardId;

    if (!cardIdToFocus) {
      return false;
    }

    if (cardIdToFocus !== activeCardId && !isSelectedCardEmpty) {
      trimCardBeforeExit(activeCardId);
    }

    return focusCardForEditing(
      cardIdToFocus === activeCardId ? fallbackCardId : cardIdToFocus,
      placement,
    );
  }

  function changeViewMode(next: typeof viewMode) {
    setStageOffset({ x: 0, y: 0 });
    setPendingEditorFocusPlacement(null);
    setPendingEditorTextInput(null);
    setViewMode(next);
    setMode("navigation");
  }

  function zoomView(direction: -1 | 1) {
    const modes = ["wide-lens", "normal", "focused"] as const;
    changeViewMode(modes[Math.max(0, Math.min(2, modes.indexOf(viewMode) + direction))]!);
  }

  function handleStageWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (disableScrollPan || uiPreferences.scrollPan === "disabled") {
      return;
    }

    if (Math.abs(event.deltaX) < 0.1 && Math.abs(event.deltaY) < 0.1) {
      return;
    }

    event.preventDefault();
    if (Date.now() < wheelPanSuppressedUntilRef.current) {
      return;
    }

    setStageOffset((currentOffset) => ({
      x: clampStageOffset(currentOffset.x - event.deltaX, stagePanLimit.x),
      y: clampStageOffset(currentOffset.y - event.deltaY, stagePanLimit.y),
    }));
  }

  useEffect(() => {
    if (!activeSnapshot || !activeCardId) {
      return;
    }

    const currentSnapshot = activeSnapshot;
    const currentCardId = activeCardId;

    function handleKeyDown(event: KeyboardEvent) {
      if (readOnly) {
        const target = event.target;
        if (!(target instanceof Element) || !workspaceRef.current?.contains(target)) return;
        const zoom = (event.metaKey || event.ctrlKey) && ["-", "+", "="].includes(event.key);
        const navigation = event.key.startsWith("Arrow") && !event.shiftKey && !event.altKey;
        if (!zoom && !navigation && !(isOverviewMode && event.key === "Enter")) return;
        if (window.getSelection()?.isCollapsed === false) return;
      }
      if (event.isComposing || event.keyCode === 229 ||
        interaction.getState().workspacePane !== "tree" ||
        (interaction.getState().workspaceDialog && !linkTarget) ||
        (event.target instanceof Element && event.target.closest(".fc-manuscript-backlinks, .fc-manuscript-divider, .fc-manuscript-pane, .fc-save-error"))) return;
      if (event.defaultPrevented || suspendKeyboard) {
        return;
      }

      if (mode === "search" || mode === "command") {
        return;
      }

      if (pendingDeleteDocument) {
        return;
      }

      if (renamingDocumentPath || createInFlightRef.current) {
        return;
      }

      if (linkTarget) {
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          if (event.repeat) return;
          if (event.key === "Escape") finishLinkTargetSelection(true);
          else if (!activeAppearance?.missing && manuscriptRef.current?.confirmLink(currentCardId)) {
            finishLinkTargetSelection();
          }
          return;
        }
        if (!event.key.startsWith("Arrow") || event.shiftKey || event.altKey) {
          event.preventDefault();
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        zoomView(-1);
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "+" || event.key === "=")
      ) {
        event.preventDefault();
        zoomView(1);
        return;
      }

      if (isOverviewMode && event.key === "Enter") {
        event.preventDefault();
        changeViewMode("normal");
        return;
      }

      if (mode === "navigation" && explorerSelection.kind !== "card") {
        if (event.key === "Tab") {
          event.preventDefault();
          tabKeyHeldRef.current = !event.metaKey && !event.ctrlKey && !event.altKey;
          return;
        }

        if (event.key === "Enter" && selectedRenamableDocument) {
          event.preventDefault();
          startRenamingSelectedDocument();
          return;
        }

        if (
          tabKeyHeldRef.current && !event.metaKey && !event.ctrlKey && !event.altKey &&
          (event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          void createDocumentInCurrentDirectory();
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();

          if (explorerSelection.kind === "current-document") {
            if (directory) rememberChild(`folder:${directory.folderPath}`, document.path);
            selectExplorer({ kind: "folder" });
            return;
          }

          if (explorerSelection.kind === "entry") {
            if (directory) rememberChild(`folder:${directory.folderPath}`, explorerSelection.path);
            selectExplorer({ kind: "folder" });
            return;
          }

          if (explorerSelection.kind === "preview-entry") {
            rememberChild(`folder:${explorerSelection.parentPath}`, explorerSelection.path);
            selectExplorer({
              kind: "entry",
              path: explorerSelection.parentPath,
            });
            return;
          }

          if (explorerSelection.kind === "folder" && directory?.parentFolderPath) {
            rememberChild(`folder:${directory.parentFolderPath}`, directory.folderPath);
            void openDirectory(directory.parentFolderPath);
          }
          return;
        }

        if (event.key === "ArrowRight") {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();

          if (explorerSelection.kind === "current-document") {
            const rootId = preferredRootCardId();

            if (rootId) {
              setActiveCardId(rootId);
            }
            selectExplorer({ kind: "card" });
            return;
          }

          if (explorerSelection.kind === "folder") {
            selectEntryAtIndex(rememberedEntryIndex(directoryEntries, directory?.folderPath));
            return;
          }

          if (explorerSelection.kind === "entry") {
            if (selectedDirectoryEntry?.kind === "folder") {
              void selectPreferredChildOfFolder(selectedDirectoryEntry);
              return;
            }

            void activateExplorerEntry(selectedDirectoryEntry);
            return;
          }

          if (explorerSelection.kind === "preview-entry") {
            if (!selectedPreviewEntry) {
              return;
            }

            if (selectedPreviewEntry.kind === "folder") {
              void openDirectory(selectedPreviewEntry.path);
              return;
            }

            if (selectedPreviewEntry.path === document.path) {
              const rootId = preferredRootCardId();

              if (rootId) {
                setActiveCardId(rootId);
              }
              selectExplorer({
                documentPath: selectedPreviewEntry.path,
                kind: "card",
                parentPath: explorerSelection.parentPath,
              });
              return;
            }

            void onOpenDocumentPath?.(selectedPreviewEntry.path);
            return;
          }
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();

          const direction = event.key === "ArrowUp" ? -1 : 1;
          if (explorerSelection.kind === "folder") {
            const nextIndex = event.metaKey || event.ctrlKey
              ? direction < 0 ? 0 : folderSiblingEntries.length - 1
              : activeFolderIndex + direction;
            const nextEntry = folderSiblingEntries[nextIndex];
            if (activeFolderIndex !== -1 && nextIndex !== activeFolderIndex && nextEntry) {
              clearChildMemory();
              setActiveCardId(firstRootCardId());
              selectFolderSibling(nextEntry);
            }
            return;
          }
          const currentIndex =
            explorerSelection.kind === "entry"
              ? selectedEntryIndex()
              : explorerSelection.kind === "preview-entry"
                ? selectedPreviewEntryIndex()
              : directoryEntries.findIndex((entry) => entry.path === document.path);
          const activeEntries =
            explorerSelection.kind === "preview-entry"
              ? previewDirectoryEntries
              : directoryEntries;
          const fallbackIndex = direction > 0 ? 0 : activeEntries.length - 1;
          const nextIndex =
            event.metaKey || event.ctrlKey
              ? direction < 0 ? 0 : activeEntries.length - 1
              : currentIndex === -1
                ? fallbackIndex
                : Math.max(0, Math.min(activeEntries.length - 1, currentIndex + direction));

          if (nextIndex !== currentIndex && activeEntries[nextIndex]) {
            clearChildMemory();
            setActiveCardId(firstRootCardId());
          }

          if (explorerSelection.kind === "preview-entry") {
            selectPreviewEntryAtIndex(nextIndex);
          } else {
            selectEntryAtIndex(nextIndex);
          }
          return;
        }

        if (
          event.key === "Enter" &&
          (explorerSelection.kind === "entry" ||
            explorerSelection.kind === "preview-entry")
        ) {
          event.preventDefault();
          void activateExplorerEntry(
            explorerSelection.kind === "preview-entry"
              ? selectedPreviewEntry
              : selectedDirectoryEntry,
          );
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          return;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          if (selectedDeletableDocument) {
            startDeletingSelectedDocument();
          }
          return;
        }

        return;
      }

      if (mode === "editing") {
        if (event.key === "Escape") {
          event.preventDefault();
          leaveEditingMode();
        }

        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        focusCardForEditing(currentCardId, null);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        tabKeyHeldRef.current = !event.metaKey && !event.ctrlKey && !event.altKey;
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.startsWith("Arrow")) {
        if (event.altKey || event.shiftKey || event.key === "ArrowRight") return;
        const direction = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : "left";
        event.preventDefault();
        const nextId = navigationBoundaryCardId(layoutCards, activeAppearanceId!, direction);
        if (!nextId || nextId === activeAppearanceId) return;
        if (direction === "left") {
          const path = [...ancestorsOfCard(layoutCards, activeAppearanceId!), layoutCardById.get(activeAppearanceId!)!];
          for (let index = 1; index < path.length; index += 1) rememberChild(path[index - 1]!.id, path[index]!.id);
        } else {
          clearChildMemory();
        }
        preserveDocumentTreeExplorerContext();
        const target = referenceLayout?.appearances.get(nextId);
        if (target) setActiveAppearance(target.path);
        setPendingEditorFocusPlacement(null);
        setPendingEditorTextInput(null);
        return;
      }

      if (isReferenceView) {
        const structural = (tabKeyHeldRef.current && event.key.startsWith("Arrow")) ||
          (event.shiftKey && event.key.startsWith("Arrow")) ||
          (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) ||
          event.key === "Delete" || event.key === "Backspace";
        if (structural && (activeAppearance?.missing || (isAliasCard &&
          (event.shiftKey || event.key === "Delete" || event.key === "Backspace")))) {
          event.preventDefault();
          return;
        }
        if (structural) setActiveCardId(currentCardId);
      }

      if (tabKeyHeldRef.current) {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          createRelativeCard("before");
          return;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          createRelativeCard("after");
          return;
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();
          createRelativeCard("child");
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          createParentLevel();
          return;
        }
      }

      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        focusCardForEditing(currentCardId, "end", event.key);
        return;
      }

      if ((event.key === "Backspace" || event.key === "Delete") && selectedCard) {
        event.preventDefault();
        handleDeleteCurrentCard(currentCardId);
        return;
      }

      if (event.shiftKey && event.key === "ArrowUp") {
        event.preventDefault();
        applyNavigationChange((snapshotToChange) =>
          moveCardWithinParent(snapshotToChange, currentCardId, -1),
        );
        return;
      }

      if (event.shiftKey && event.key === "ArrowDown") {
        event.preventDefault();
        applyNavigationChange((snapshotToChange) =>
          moveCardWithinParent(snapshotToChange, currentCardId, 1),
        );
        return;
      }

      if (
        event.altKey &&
        event.metaKey === false &&
        event.ctrlKey === false &&
        event.shiftKey === false &&
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        handleMergeCurrentCard(currentCardId, "up");
        return;
      }

      if (
        event.altKey &&
        event.metaKey === false &&
        event.ctrlKey === false &&
        event.shiftKey === false &&
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        handleMergeCurrentCard(currentCardId, "down");
        return;
      }

      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        applyNavigationChange((snapshotToChange) =>
          outdentCard(snapshotToChange, currentCardId),
        );
        return;
      }

      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        applyNavigationChange((snapshotToChange) =>
          indentCardUnderPreviousSibling(snapshotToChange, currentCardId),
        );
        return;
      }

      const nextCardId =
        event.key === "ArrowLeft"
          ? parentCardId(layoutCards, activeAppearanceId!)
          : event.key === "ArrowRight"
            ? preferredChildCardId(layoutCards, activeAppearanceId!, layoutRememberedChildren)
            : event.key === "ArrowUp"
              ? previousCardInColumn(layoutCards, activeAppearanceId!)
              : event.key === "ArrowDown"
                ? nextCardInColumn(layoutCards, activeAppearanceId!)
                : null;

      if (!nextCardId) {
        if (
          !linkTarget && event.key === "ArrowLeft" &&
          selectedCard?.parentId === null &&
          directory
        ) {
          event.preventDefault();
          rememberChild(`document:${document.path}`, currentCardId);
          selectExplorer(
            explorerSelection.kind === "card" &&
              explorerSelection.parentPath &&
              explorerSelection.documentPath
              ? {
                  kind: "preview-entry",
                  parentPath: explorerSelection.parentPath,
                  path: explorerSelection.documentPath,
                }
              : { kind: "current-document" },
          );
          setPendingEditorFocusPlacement(null);
          setPendingEditorTextInput(null);
        }
        return;
      }

      event.preventDefault();
      preserveDocumentTreeExplorerContext();
      if (event.key === "ArrowLeft") {
        rememberChild(nextCardId, activeAppearanceId!);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        clearChildMemory();
      }
      const nextAppearance = referenceLayout?.appearances.get(nextCardId);
      if (nextAppearance) setActiveAppearance(nextAppearance.path);
      setPendingEditorFocusPlacement(null);
      setPendingEditorTextInput(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === "Tab") {
        tabKeyHeldRef.current = false;
      }
    }

    function handleWindowBlur() {
      tabKeyHeldRef.current = false;
    }
  }, [
    activeCardId,
    referencePath,
    activeAppearanceId,
    activeSnapshot,
    applyNavigationChange,
    directory,
    rememberedChildIds,
    rememberChild,
    clearChildMemory,
    directoryEntries,
    parentDirectory,
    folderSiblingEntries,
    activeFolderIndex,
    explorerSelection,
    linkTarget,
    viewMode,
    mode,
    previewDirectoryEntries,
    pendingDeleteDocument,
    redoNavigation,
    redoEditing,
    readOnly,
    selectedCard?.parentId,
    selectedDeletableDocument,
    selectedDirectoryEntry,
    selectedPreviewEntry,
    selectedCardContent,
    setActiveCardId,
    setMode,
    suspendKeyboard,
    undoNavigation,
    undoEditing,
  ]);

  useEffect(() => listenForFrontendMenuActions(handleFrontendMenuAction), [
    viewMode,
    activeCardId,
    referencePath,
    activeAppearanceId,
    activeSnapshot,
    applyNavigationChange,
    canCreateStructure,
    mode,
    redoNavigation,
    redoEditing,
    selectedCard,
    selectedCardContent,
    suspendKeyboard,
    undoNavigation,
    undoEditing,
  ]);

  useEffect(() => {
    function handleCopy(event: ClipboardEvent) {
      if (event.target instanceof Element && event.target.closest(".fc-history-timeline")) return;
      if (readOnly) {
        if (!activeSnapshot || !activeCardId || interaction.getState().workspacePane !== "tree" ||
          !(event.target instanceof Element) || !workspaceRef.current?.contains(event.target) ||
          window.getSelection()?.isCollapsed === false || !event.clipboardData) return;
        event.preventDefault();
        writeCardClipboardPayload(event, createCardSubtreeCopyPayload(activeSnapshot, activeCardId));
        return;
      }
      if (!canHandleCardClipboard() || !activeSnapshot || !activeCardId) return;
      if (activeAppearance?.missing) { event.preventDefault(); return; }

      try {
        const payload = createCardCopyPayload(activeSnapshot, activeCardId);

        event.preventDefault();
        writeCardClipboardPayload(event, payload);
        setNotice({
          tone: "info",
          message: "Copied card content.",
        });
      } catch (error) {
        console.error(error);
        setNotice({
          tone: "error",
          message: "Fablecraft could not copy that card.",
        });
      }
    }

    function handleCut(event: ClipboardEvent) {
      if (event.target instanceof Element && event.target.closest(".fc-history-timeline")) return;
      if (!canHandleCardClipboard() || !activeSnapshot || !activeCardId) return;
      if (isReferenceView && (isAliasCard || activeAppearance?.missing)) { event.preventDefault(); return; }
      if (isReferenceView) setActiveCardId(activeCardId);

      try {
        const payload = createCardCutPayload(activeSnapshot, activeCardId);
        const fallbackCardId =
          activeSnapshot.cards.length <= 1
            ? activeCardId
            : fallbackCardIdAfterDelete(activeSnapshot, activeCardId) ?? activeCardId;

        event.preventDefault();
        writeCardClipboardPayload(event, payload);
        applyNavigationChange((snapshotToChange) =>
          removeCutSubtree(snapshotToChange, activeCardId),
        );
        setActiveCardId(fallbackCardId);
        setPendingEditorFocusPlacement(null);
        setPendingEditorTextInput(null);
        setNotice({
          tone: "info",
          message: "Cut card subtree.",
        });
      } catch (error) {
        console.error(error);
        setNotice({
          tone: "error",
          message: "Fablecraft could not cut that card.",
        });
      }
    }

    function handlePaste(event: ClipboardEvent) {
      if (readOnly) return;
      if (event.target instanceof Element && event.target.closest(".fc-history-timeline")) return;
      if (isReferenceView && canHandleCardClipboard()) {
        if (activeAppearance?.missing) { event.preventDefault(); return; }
        setActiveCardId(activeCardId);
      }
      if (mode === "editing" && !suspendKeyboard && !pendingDeleteDocument && explorerSelection.kind === "card") {
        const copied = readCardClipboardPayload(event);
        if (copied?.kind === "subtree" && copied.operation === "copy" &&
          interaction.getState().workspacePane === "tree" && !canHandleCardClipboard(true)) {
          event.preventDefault();
          event.stopPropagation();
          setNotice({ tone: "info", message: "Paste a subtree in Tree navigation or into an empty card." });
          return;
        }
        if (copied?.kind === "content" && copied.operation === "copy") {
          const snapshot = useDocumentStore.getState().snapshot;
          if (snapshot?.summary.documentId !== copied.source.documentId ||
            !snapshot.cards.some((card) => card.id === copied.source.rootCardId)) {
            event.preventDefault();
            event.stopPropagation();
            setNotice({ tone: "error", message: "Card links require an existing card in this document." });
          }
          // The editor inserts copied-card references at its current selection.
          return;
        }
      }

      if (!canHandleCardClipboard(true) || !activeSnapshot || !activeCardId) {
        return;
      }

      const payload = readCardClipboardPayload(event);

      if (!payload) {
        if (mode === "editing") {
          return;
        }

        event.preventDefault();
        setNotice({
          tone: "error",
          message: "Clipboard does not contain a Fablecraft card.",
        });
        return;
      }

      try {
        const pasteResult = pasteCardClipboardPayloadWithResult(
          useDocumentStore.getState().snapshot ?? activeSnapshot,
          activeCardId,
          payload,
          () => randomId("card"),
        );

        event.preventDefault();
        event.stopPropagation();
        if (mode === "editing") {
          updateSnapshot(() => pasteResult.snapshot);
        } else {
          applyNavigationChange(() => pasteResult.snapshot);
        }
        setActiveCardId(pasteResult.pastedRootCardId);
        setPendingEditorFocusPlacement(mode === "editing" ? "end" : null);
        setPendingEditorTextInput(null);
        setNotice({
          tone: "info",
          message:
            payload.kind === "subtree"
              ? "Pasted card subtree."
              : "Pasted card content.",
        });
      } catch (error) {
        event.preventDefault();
        console.error(error);
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Fablecraft could not paste that card.",
        });
      }
    }

    window.addEventListener("copy", handleCopy, true);
    window.addEventListener("cut", handleCut, true);
    window.addEventListener("paste", handlePaste, true);

    return () => {
      window.removeEventListener("copy", handleCopy, true);
      window.removeEventListener("cut", handleCut, true);
      window.removeEventListener("paste", handlePaste, true);
    };
  }, [
    readOnly,
    activeCardId,
    referencePath,
    activeAppearanceId,
    activeSnapshot,
    applyNavigationChange,
    explorerSelection.kind,
    mode,
    pendingDeleteDocument,
    setActiveCardId,
    setNotice,
    suspendKeyboard,
    updateSnapshot,
  ]);

  return (
    <section ref={workspaceRef} data-history-preview={readOnly || undefined} className="fc-workspace relative flex h-full w-full items-stretch overflow-hidden"
      style={{
        "--fc-manuscript-top": `${manuscriptLayoutTokens.topInset}px`,
        "--fc-manuscript-padding": `${splitFits ? manuscriptLayoutTokens.panePadding : manuscriptLayoutTokens.touchPanePadding}px`,
        "--fc-manuscript-prose-width": `${manuscriptLayoutTokens.proseMaximum}px`,
        "--fc-manuscript-link-bar-width": `${manuscriptLayoutTokens.linkBarWidth}px`,
        "--fc-manuscript-control-gap": `${manuscriptLayoutTokens.controlGap}px`,
      } as React.CSSProperties}>
      {!readOnly && <LiveWorkspaceSync document={document} />}
      <div className="fc-pane-announcement" aria-live="polite">
        {activePane === "tree" ? "Tree active" : "Manuscript active"}
      </div>
      {!isExplorerSelectionActive ? (
        <div className="fc-document-title" data-testid="document-title">
          <span title={documentNameWithoutExtension(activeSnapshot?.summary.name ?? document.name)}>
            {documentNameWithoutExtension(activeSnapshot?.summary.name ?? document.name)}
          </span>
        </div>
      ) : null}
      <div className="fc-tree-pane relative h-full min-w-0" aria-label="Tree"
        style={{ width: treeWidth ?? "100%", display: showTree ? undefined : "none" }}
        onFocusCapture={() => activatePane("tree")}
        onPointerDownCapture={(event) => {
          if (linkTarget) event.preventDefault();
          else activatePane("tree");
        }}
        onDoubleClickCapture={(event) => {
          if (!linkTarget) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClickCapture={(event) => {
          if (!linkTarget) return;
          event.preventDefault();
          event.stopPropagation();
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-appearance-id]") : null;
          const appearanceId = target?.dataset.appearanceId;
          const appearance = appearanceId && referenceLayout?.appearances.get(appearanceId);
          if (appearance) setActiveAppearance(appearance.path);
        }}>
      <div
        ref={stageRef}
        tabIndex={-1}
        style={{ "--fc-card-width": `${uiMetrics.cardWidth}px` } as React.CSSProperties}
        data-view-mode={viewMode}
        data-columns={isOverviewMode || isExplorerSelectionActive ? undefined : writing.columns}
        data-testid="document-stage"
        className="relative h-full w-full overflow-hidden outline-none"
        onWheel={handleStageWheel}
      >
        {focusedNavigationDirections.length > 0 ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3]" data-testid="focused-navigation-hints">
            {focusedNavigationDirections.map(({ direction, rotation }) => {
              const vertical = direction === "up" || direction === "down";
              return (
                <svg
                  key={direction}
                  data-testid={`focused-chevron-${direction}`}
                  className="absolute"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--fc-color-overview-connector)"
                  strokeWidth="var(--fc-focused-navigation-stroke-width)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    width: "var(--fc-focused-navigation-size)",
                    height: "var(--fc-focused-navigation-size)",
                    left: vertical ? "50%" : direction === "left" ? "var(--fc-focused-navigation-inset)" : undefined,
                    right: direction === "right" ? "var(--fc-focused-navigation-inset)" : undefined,
                    top: vertical ? direction === "up" ? "var(--fc-focused-navigation-top-inset)" : undefined : "50%",
                    bottom: direction === "down" ? "var(--fc-focused-navigation-inset)" : undefined,
                    transform: `${vertical ? "translateX(-50%)" : "translateY(-50%)"} rotate(${rotation}deg)`,
                  }}
                >
                  <path d="M9 5l7 7-7 7" />
                </svg>
              );
            })}
          </div>
        ) : null}
        {directory && !isOverviewMode && isExplorerSelectionActive ? (
          <>
            {parentFolderName && explorerSelection.kind === "folder" ? (
              <ExplorerCard
                isActive={false}
                kind="folder"
                label={parentFolderName}
                meta="FOLDER"
                onClick={() => {
                  if (directory.parentFolderPath) {
                    void openDirectory(directory.parentFolderPath);
                  }
                }}
                width={explorerCardWidth}
                x={-explorerColumnWidth + stageOffset.x}
                y={stageOffset.y}
              />
            ) : null}
            {explorerSelection.kind !== "preview-entry" ? (
              <ExplorerCard
                isActive={explorerSelection.kind === "folder"}
                kind="folder"
                label={directory.folderName}
                meta="FOLDER"
                onClick={() => {
                  selectExplorer({ kind: "folder" });
                  setMode("navigation");
                }}
                width={explorerCardWidth}
                x={
                  explorerSelection.kind === "folder"
                    ? stageOffset.x
                    : explorerSelection.kind === "entry"
                      ? -explorerColumnWidth + stageOffset.x
                      : -explorerColumnWidth + stageOffset.x
                }
                y={stageOffset.y}
              />
            ) : null}
            {explorerSelection.kind === "folder" && activeFolderIndex !== -1
              ? folderSiblingEntries.map((entry, index) =>
                  entry.path === directory.folderPath ? null : (
                    <ExplorerCard
                      isActive={false}
                      key={entryId(entry)}
                      kind={entry.kind === "folder" ? "folder" : "document"}
                      label={explorerLabelForEntry(entry)}
                      meta={entry.kind === "folder" ? "FOLDER" : "FABLE"}
                      onClick={() => selectFolderSibling(entry)}
                      width={explorerCardWidth}
                      x={stageOffset.x}
                      y={(index - activeFolderIndex) * explorerRowGap + stageOffset.y}
                    />
                  ),
                )
              : null}
            {explorerSelection.kind === "preview-entry" && selectedDirectoryEntry ? (
              <ExplorerCard
                isActive={false}
                kind={selectedDirectoryEntry.kind === "folder" ? "folder" : "document"}
                label={explorerLabelForEntry(selectedDirectoryEntry)}
                meta={selectedDirectoryEntry.kind === "folder" ? "FOLDER" : "FABLE"}
                onClick={() => {
                  selectExplorer({
                    kind: "entry",
                    path: selectedDirectoryEntry.path,
                  });
                  setMode("navigation");
                }}
                width={explorerCardWidth}
                {...(selectedDirectoryEntry.kind === "document"
                  ? renamePropsForDocument(selectedDirectoryEntry.path)
                  : {})}
                x={-explorerColumnWidth + stageOffset.x}
                y={stageOffset.y}
              />
            ) : null}
            {shouldRenderDirectoryEntryColumn ? (
              directoryEntries.map((entry, index) => (
                <ExplorerCard
                  isActive={
                    explorerSelection.kind === "current-document"
                      ? entry.path === directory.currentDocumentPath
                      : explorerSelection.kind === "entry" &&
                        explorerSelection.path === entry.path
                  }
                  key={entryId(entry)}
                  kind={entry.kind === "folder" ? "folder" : "document"}
                  label={explorerLabelForEntry(entry)}
                  meta={entry.kind === "folder" ? "FOLDER" : "FABLE"}
                  onClick={() => {
                    selectExplorer({ kind: "entry", path: entry.path });
                    setMode("navigation");
                  }}
                  width={explorerCardWidth}
                  {...(entry.kind === "document"
                    ? renamePropsForDocument(entry.path)
                    : {})}
                  x={
                    explorerSelection.kind === "folder"
                      ? explorerColumnWidth + stageOffset.x
                      : stageOffset.x
                  }
                  y={explorerEntryY(index) + stageOffset.y}
                />
              ))
            ) : shouldRenderCurrentDocumentFallback ? (
              <ExplorerCard
                isActive={explorerSelection.kind === "current-document"}
                kind="document"
                label={currentDocumentName}
                meta="FABLE"
                onClick={() => {
                  selectExplorer({ kind: "current-document" });
                  setMode("navigation");
                }}
                width={explorerCardWidth}
                {...renamePropsForDocument(directory?.currentDocumentPath ?? document.path)}
                x={
                  explorerSelection.kind === "current-document"
                    ? stageOffset.x
                    : -explorerToDocumentOffset + stageOffset.x
                }
                y={stageOffset.y}
              />
            ) : null}
            {shouldRenderPreviewEntryColumn ? (
              previewDirectoryEntries.map((entry, index) => (
                <ExplorerCard
                  isActive={
                    explorerSelection.kind === "preview-entry" &&
                    explorerSelection.path === entry.path
                  }
                  key={`preview:${entryId(entry)}`}
                  kind={entry.kind === "folder" ? "folder" : "document"}
                  label={explorerLabelForEntry(entry)}
                  meta={entry.kind === "folder" ? "FOLDER" : "FABLE"}
                  onClick={() => {
                    if (entry.kind === "folder") {
                      void openDirectory(entry.path);
                      return;
                    }

                    void onOpenDocumentPath?.(entry.path);
                  }}
                  width={explorerCardWidth}
                  {...(entry.kind === "document"
                    ? renamePropsForDocument(entry.path)
                    : {})}
                  x={
                    explorerSelection.kind === "entry"
                      ? explorerColumnWidth + stageOffset.x
                      : stageOffset.x
                  }
                  y={previewEntryY(index) + stageOffset.y}
                />
              ))
            ) : null}
          </>
        ) : null}
        {directoryLoadError && !isOverviewMode && isExplorerSelectionActive ? (
          <p
            className="pointer-events-none absolute left-1/2 top-1/2 m-0 max-w-[360px] -translate-x-1/2 translate-y-[72px] text-center font-[var(--fc-font-ui)] text-[12px] text-[var(--fc-color-muted)]"
            data-testid="directory-load-error"
          >
            {directoryLoadError}
          </p>
        ) : null}
        {emptyChildGap && !isOverviewMode && !isExplorerSelectionActive ? (
          <button
            aria-label="Create child card"
            className="absolute w-[var(--fc-card-width)] cursor-pointer appearance-none border-0 bg-transparent p-0 transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
            data-testid="empty-child-gap"
            disabled={!canCreateStructure}
            onClick={() => {
              if (!canCreateStructure) {
                return;
              }

              createRelativeCard("child");
            }}
            style={{
              left: `calc(50% + ${emptyChildGap.x + stageOffset.x}px)`,
              minHeight: `${emptyChildGap.height}px`,
              opacity: "1",
              top: `calc(50% + ${emptyChildGap.y + stageOffset.y}px)`,
              transform: "translate(-50%, -50%)",
              zIndex: 0,
            }}
            type="button"
          />
        ) : null}
        {shouldShowDocumentTree && isOverviewMode && overviewConnectors.length > 0 ? (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px overflow-visible"
            data-testid="overview-connectors"
            ref={overviewConnectorsRef}
            style={{
              transform: `translate(${stageOffset.x}px, ${stageOffset.y}px)`,
              zIndex: 0,
            }}
          >
            {overviewConnectors.map((connector) => (
              <path
                d={connector.path}
                data-child-card-id={connector.childCardId}
                data-highlighted={
                  connector.parentCardId === activeAppearanceId ||
                  highlightedOverviewConnectorParentIds.has(connector.parentCardId) ||
                  highlightedOverviewConnectorChildIds.has(connector.childCardId)
                    ? "true"
                    : "false"
                }
                data-parent-card-id={connector.parentCardId}
                data-testid="overview-connector"
                fill="none"
                key={`${connector.parentCardId}-${connector.childCardId}`}
                stroke={
                  connector.parentCardId === activeAppearanceId ||
                  highlightedOverviewConnectorParentIds.has(connector.parentCardId) ||
                  highlightedOverviewConnectorChildIds.has(connector.childCardId)
                    ? "var(--fc-color-overview-connector-active)"
                    : "var(--fc-color-overview-connector)"
                }
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="4.5"
              />
            ))}
          </svg>
        ) : null}
        {shouldShowDocumentTree ? visibleTreeCards.map((card) => {
          const displayX = card.x + stageOffset.x;
          const displayY = card.y + stageOffset.y;
          const activeCardOverflowsViewport =
            !isOverviewMode &&
            card.isActive &&
            card.height >
              workspaceViewportHeight - ACTIVE_CARD_VIEWPORT_BUFFER * 2;
          const activeCardTop = activeCardOverflowsViewport
            ? workspaceViewportHeight / 2 + displayY - card.height / 2
            : null;

          return (
                !isOverviewMode &&
                !card.appearance.isReference &&
                card.isActive &&
                !isExplorerSelectionActive &&
                selectedCard &&
                selectedCardContent ? (
                  <div
                    data-testid="active-card-shell"
                    data-appearance-id={card.cardId}
                    data-manuscript-target={selectedCard.id}
                    className="absolute flex w-[var(--fc-card-width)] flex-col justify-start border px-5 py-[10px] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
                    ref={activeCardShellRef}
                    key={card.cardId}
                    onClick={() => {
                      if (readOnly) {
                        if (window.getSelection()?.isCollapsed !== false) stageRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      if (!isEditingSelectedCard) setStageOffset({ x: 0, y: 0 });
                      setMode("editing");
                    }}
                    role="presentation"
                    style={{
                      backgroundColor: showActiveCardStyle
                        ? treePaneActive && isEditingSelectedCard ? "var(--fc-color-card-surface-editing)" : "var(--fc-color-card-surface-active)"
                        : "var(--fc-color-card-surface)",
                      borderColor: "transparent",
                      borderWidth: "0px",
                      boxShadow: showActiveCardStyle ? "var(--fc-shadow-elevated)" : "none",
                      left: `calc(50% + ${displayX}px)`,
                      // Cached/estimated heights position cards; only the base
                      // minimum may constrain the surface we measure for that cache.
                      minHeight: `${uiMetrics.cardHeight}px`,
                      paddingBottom: `${activeBottomPadding}px`,
                      paddingLeft: `${activeHorizontalPadding}px`,
                      paddingRight: `${activeHorizontalPadding}px`,
                      paddingTop: `${activeTopPadding}px`,
                      top:
                        activeCardTop === null
                          ? `calc(50% + ${displayY}px)`
                          : `${activeCardTop}px`,
                      transform: activeCardOverflowsViewport
                        ? "translateX(-50%)"
                        : "translate(-50%, -50%)",
                      zIndex: 2,
                    }}
                  >
                    <CardIdentity
                      cardLabel={cardNumbers[selectedCard.id] ?? selectedCard.id.toUpperCase()}
                      descendantCount={descendantCounts[selectedCard.id] ?? 0}
                    />
                    <CardEditor
                      selectionViewportKey={`${workspaceViewportWidth}:${workspaceViewportHeight}:${uiPreferences.font}:${uiPreferences.textSize}:${uiPreferences.lineHeight}`}
                      onRevealSelection={(bounds) => {
                        if (!treePaneActive) return;
                        const stageBounds = stageRef.current?.getBoundingClientRect();
                        const top = (stageBounds?.top ?? 0) + writingLayoutTokens.verticalInset;
                        const bottom = (stageBounds?.top ?? 0) + workspaceViewportHeight - writingLayoutTokens.verticalInset;
                        const delta = bounds.top < top ? top - bounds.top
                          : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
                        if (delta) setStageOffset((offset) => ({ ...offset, y: offset.y + delta }));
                      }}
                      cardLabels={cardNumbers}
                      documentId={activeSnapshot?.summary.documentId}
                      onOpenCardLink={openCardLink}
                      onCreateAnchoredChild={createAnchoredChild}
                      onOpenAnchoredChild={(childId) => openAnchoredChild(selectedCard.id, childId)}
                      onPassageAnchorError={(message) => setNotice({ tone: "error", message })}
                      readOnly={readOnly}
                      historyRange={historyPreview?.focus.cardId === selectedCard.id ? historyPreview.focus.cardRange : undefined}
                      historyRangeRequest={historyPreview?.focus.request}
                      historyAdditions={historyAdditions.cards.get(selectedCard.id)}
                      canLeaveEditing={canLeaveEditing}
                      canCreateStructure={canCreateStructure}
                      focusPlacement={pendingEditorFocusPlacement}
                      key={selectedCard.id}
                      contentJson={selectedCardContent}
                      isEditing={mode === "editing"}
                      paneActive={treePaneActive && !linkTarget}
                      onConsumeFocusPlacement={() => setPendingEditorFocusPlacement(null)}
                      onConsumePendingTextInput={() => setPendingEditorTextInput(null)}
                      onCreateBelow={(splitContent) => {
                        if (!canCreateStructure) {
                          return;
                        }

                        const newCardId = randomId("card");
                        applyNavigationChange((snapshotToChange) => {
                          let nextSnapshot = createSiblingAfter(
                            snapshotToChange,
                            selectedCard.id,
                            newCardId,
                          );

                          nextSnapshot = replaceCardContent(nextSnapshot, {
                            cardId: selectedCard.id,
                            contentJson: splitContent?.before ?? trimTrailingEmptyParagraphs(
                              cardContent(nextSnapshot, selectedCard.id),
                            ),
                          });

                          return splitContent
                            ? replaceCardContent(nextSnapshot, {
                                cardId: newCardId,
                                contentJson: splitContent.after,
                              })
                            : nextSnapshot;
                        });
                        focusCardForEditing(newCardId, splitContent ? "start" : "end");
                      }}
                      onCreateChild={() => {
                        if (!canCreateStructure) {
                          return;
                        }

                        const newCardId = randomId("card");
                        applyNavigationChange((snapshotToChange) =>
                          createChildCard(snapshotToChange, selectedCard.id, newCardId),
                        );
                        focusCardForEditing(newCardId, "end");
                      }}
                      onDeleteEmpty={() => {
                        if (!activeSnapshot || !isSelectedCardEmpty) {
                          return;
                        }

                        const unwrappedFallbackCardId = unwrapEmptyCardWithChildren();

                        if (unwrappedFallbackCardId) {
                          focusCardForEditing(unwrappedFallbackCardId, "end");
                          return;
                        }

                        if (activeSnapshot.cards.length <= 1) {
                          return;
                        }

                        const fallbackCardId = fallbackCardIdAfterEmptyAbandon(
                          activeSnapshot,
                          selectedCard.id,
                        );
                        if (deleteEmptyLeafCard(fallbackCardId)) {
                          focusCardForEditing(fallbackCardId, "end");
                        }
                      }}
                      onMergeAbove={() => {
                        applyNavigationChange((snapshotToChange) =>
                          mergeCardWithPreviousSibling(snapshotToChange, selectedCard.id),
                        );
                        return focusCardForEditing(selectedCard.id, "end");
                      }}
                      onMergeBelow={() => {
                        applyNavigationChange((snapshotToChange) =>
                          mergeCardWithNextSibling(snapshotToChange, selectedCard.id),
                        );
                        return focusCardForEditing(selectedCard.id, "end");
                      }}
                      onCreateParentLevel={() => {
                        if (!canCreateStructure) {
                          return;
                        }

                        const newCardId = randomId("card");
                        wrappedParentSourceChildRef.current[newCardId] = selectedCard.id;
                        applyNavigationChange((snapshotToChange) =>
                          wrapLevelInParent(snapshotToChange, selectedCard.id, newCardId),
                        );
                        focusCardForEditing(newCardId, "end");
                      }}
                      onCreateSiblingAbove={() => {
                        if (!canCreateStructure) {
                          return;
                        }

                        const newCardId = randomId("card");
                        applyNavigationChange((snapshotToChange) =>
                          createSiblingBefore(snapshotToChange, selectedCard.id, newCardId),
                        );
                        focusCardForEditing(newCardId, "end");
                      }}
                      onCreateSiblingBelow={() => {
                        if (!canCreateStructure) {
                          return;
                        }

                        const newCardId = randomId("card");
                        applyNavigationChange((snapshotToChange) =>
                          createSiblingAfter(snapshotToChange, selectedCard.id, newCardId),
                        );
                        focusCardForEditing(newCardId, "end");
                      }}
                      onNavigateChild={(placement = "start") => {
                        if (!activeSnapshot) {
                          return false;
                        }

                        return navigateFromEditing(
                          firstChildCardId(activeSnapshot.cards, selectedCard.id),
                          placement,
                        );
                      }}
                      onNavigateParent={(placement = "end") => {
                        if (!activeSnapshot) {
                          return false;
                        }

                        return navigateFromEditing(
                          parentCardId(activeSnapshot.cards, selectedCard.id),
                          placement,
                        );
                      }}
                      onNavigateAbove={(placement = "end") => {
                        if (!activeSnapshot) {
                          return false;
                        }

                        const previousCardId = previousCardInColumn(
                          activeSnapshot.cards,
                          selectedCard.id,
                        );

                        if (!previousCardId) {
                          return false;
                        }

                        return navigateFromEditing(previousCardId, placement);
                      }}
                      onNavigateBelow={(placement = "start") => {
                        if (!activeSnapshot) {
                          return false;
                        }

                        const nextCardId = nextCardInColumn(
                          activeSnapshot.cards,
                          selectedCard.id,
                        );

                        if (!nextCardId) {
                          return false;
                        }

                        return navigateFromEditing(nextCardId, placement);
                      }}
                      pendingTextInput={pendingEditorTextInput}
                      placeholder={activePlaceholder}
                      onRedo={redoEditing}
                      onRequestNavigation={leaveEditingMode}
                      onUndo={undoEditing}
                      onSplitAtSelection={(selectionStart, selectionEnd, richSplit) => {
                        const splitContent = richSplit ?? splitCardContentAtTextOffset(
                          selectedCardContent,
                          selectionStart,
                          selectionEnd,
                        );
                        const newCardId = randomId("card");

                        applyNavigationChange((snapshotToChange) => {
                          let nextSnapshot = createSiblingAfter(
                            snapshotToChange,
                            selectedCard.id,
                            newCardId,
                          );
                          nextSnapshot = replaceCardContent(nextSnapshot, {
                            cardId: selectedCard.id,
                            contentJson: splitContent.before,
                          });

                          return replaceCardContent(nextSnapshot, {
                            cardId: newCardId,
                            contentJson: splitContent.after,
                          });
                        });

                        focusCardForEditing(newCardId, "end");
                      }}
                      onUpdateContent={(contentJson) => {
                        updateSnapshot((snapshotToChange) =>
                          replaceCardContent(snapshotToChange, {
                            cardId: selectedCard.id,
                            contentJson,
                          }),
                        );
                      }}
                    />
                    <ManuscriptBacklinks entries={backlinks.get(selectedCard.id) ?? []} onReveal={showPassage}
                      onRemove={readOnly ? undefined : (entry) => removeManuscriptBacklink(entry.id, selectedCard.id)} />
                  </div>
                ) : (
                  <TreeCardButton
                    historyAdditions={historyAdditions.cards.get(card.appearance.cardId)}
                    cardLabels={cardNumbers}
                    manuscriptTarget={card.appearance.missing ? undefined : card.appearance.cardId}
                    manuscriptFooter={<ManuscriptBacklinks entries={backlinks.get(card.appearance.cardId) ?? []}
                      onReveal={showPassage} onRemove={readOnly ? undefined : (entry) => removeManuscriptBacklink(entry.id, card.appearance.cardId)}
                      compact={isOverviewMode} />}
                    isReference={card.appearance.isReference}
                    appearanceId={card.cardId}
                    viewportTop={activeCardTop}
                    onEdit={() => focusCardForEditing(card.appearance.cardId)}
                    onOpenCardLink={openCardLink}
                    activeAnchoredChildId={activeCardId ?? undefined}
                    onOpenAnchoredChild={(childId) => openAnchoredChild(card.appearance.cardId, childId)}
                    borderColor="transparent"
                    cardWidth={isOverviewMode ? OVERVIEW_CARD_WIDTH : undefined}
                    cardLabel={card.appearance.missing ? "?" : cardNumbers[card.appearance.cardId] ?? card.appearance.cardId.toUpperCase()}
                    contentJson={card.contentJson}
                    descendantCount={descendantCounts[card.appearance.cardId] ?? 0}
                    placeholder={
                      card.appearance.missing ? "Deleted card" :
                        !isFirstRootCardId(card.appearance.cardId) && isContentEffectivelyEmpty(card.contentJson)
                          ? "empty card" : ""
                    }
                    isActive={card.isActive && !isExplorerSelectionActive}
                    paneActive={showActiveCardStyle}
                    minHeight={isOverviewMode ? OVERVIEW_CARD_HEIGHT : undefined}
                    key={card.cardId}
                    onMeasureHeight={(height) => {
                      if (isOverviewMode) {
                        return;
                      }

                      updateCardHeight(card.appearance.cardId, height, true);
                    }}
                    onClick={() => {
                      setStageOffset({ x: 0, y: 0 });
                      preserveDocumentTreeExplorerContext();
                      if (card.appearance.isReference) {
                        if (card.isActive && !isOverviewMode) { focusCardForEditing(card.appearance.cardId); return; }
                        setActiveAppearance(card.appearance.path);
                        setPendingEditorFocusPlacement(null);
                        setPendingEditorTextInput(null);
                        setMode("navigation");
                        if (readOnly) stageRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      setActiveCardId(card.appearance.cardId);
                      setPendingEditorFocusPlacement(isOverviewMode ? null : "start");
                      setPendingEditorTextInput(null);
                      if (readOnly) stageRef.current?.focus({ preventScroll: true });
                      if (!isOverviewMode) {
                        setMode("editing");
                      }
                    }}
                    scale={isOverviewMode ? overviewScale : 1}
                    titleOnly={isOverviewMode}
                    x={displayX}
                    y={displayY}
                  />
                )
              );
            }) : null}
      </div>
      </div>
      {bothVisible && (
        <div className="fc-manuscript-divider" role="separator" aria-label="Resize Tree and Manuscript"
          tabIndex={0} aria-orientation="vertical" aria-valuenow={Math.round((treeWidth ?? 0) / workspaceWidth * 100)}
          style={{ width: manuscriptLayoutTokens.dividerWidth }}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            // Pointer capture routes the drag, but does not suppress native text selection.
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              setTreeRatio(event.clientX - (workspaceRef.current?.getBoundingClientRect().left ?? 0));
            }
          }}
          onKeyDown={(event) => {
            const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (!direction || event.defaultPrevented) return;
            event.preventDefault();
            setTreeRatio((treeWidth ?? 0) + direction * manuscriptLayoutTokens.dividerKeyboardStep);
          }} />
      )}
      {activeSnapshot && showManuscript && readOnly && !manuscript && (
        <div className="fc-manuscript-pane fc-history-empty-manuscript">This snapshot has no manuscript.</div>
      )}
      {activeSnapshot && (!readOnly || manuscript) && (
        <ManuscriptPane key={document.documentId} readOnly={readOnly} ref={manuscriptRef} visible={showManuscript}
          active={activePane === "manuscript"} snapshot={activeSnapshot} entries={manuscriptEntries} labels={cardNumbers}
          reveal={revealPassage} historyAdditions={historyAdditions.manuscript}
          onActivate={() => { if (!linkTarget) activatePane("manuscript"); }}
          onNotice={(message) => setNotice({ tone: "error", message })}
          onLinkedCardChange={setLinkedManuscriptCard}
          onLinkEligibilityChange={(manuscriptLinkEligible) => interaction.setState({ manuscriptLinkEligible })}
          choosingCard={Boolean(linkTarget)}
          typographyKey={`${uiPreferences.font}:${uiPreferences.textSize}:${uiPreferences.lineHeight}`}
          onLinkInvalidated={finishLinkTargetSelection} />
      )}
      {linkTarget && (
        <div className="fc-link-target-hint" role="status">Choose a card. Enter to link, Esc to cancel.</div>
      )}
      {!readOnly && saveError && activeSnapshot && (
        <div className="fc-save-error" role="alert">
          <span>{saveError}</span>
          {revisionConflict && (
            <div>
              <button type="button" disabled={recovering} onClick={() => void resolveSaveConflict("copy")}>
                Save a Separate Copy
              </button>
              <button type="button" disabled={recovering} onClick={() => void resolveSaveConflict("reload")}>
                Reload Latest Revision
              </button>
            </div>
          )}
        </div>
      )}
      {pendingDeleteDocument ? (
        <OverlayShell
          onBackdropMouseDown={cancelDeleteDocument}
          title="Move Document to Trash"
          widthClassName="max-w-[min(92vw,520px)]"
        >
          <div className="space-y-7">
            <p className="font-[var(--fc-font-content)] text-[1.05rem] leading-7 text-[var(--fc-color-text)]">
              Move "{pendingDeleteDocument.name}" and all its contents to Trash?
            </p>
            {documentDeleteError ? (
              <p
                className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words font-[var(--fc-font-ui)] text-sm leading-6 text-red-600"
                data-testid="delete-document-error"
              >
                {documentDeleteError}
              </p>
            ) : null}
            <div className="flex justify-center gap-3">
              <button
                aria-pressed={selectedDeleteDocumentAction === "cancel"}
                className={`min-w-[7.5rem] rounded-[var(--fc-radius-pill)] bg-[var(--fc-color-surface-strong)] px-5 py-2.5 font-[var(--fc-font-ui)] text-sm text-[var(--fc-color-text)] outline-none transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)] hover:-translate-y-[1px] ${
                  selectedDeleteDocumentAction === "cancel"
                    ? "shadow-[var(--fc-shadow-elevated)] ring-2 ring-[var(--fc-color-text)]"
                    : "shadow-[var(--fc-shadow-soft)]"
                }`}
                data-testid="cancel-delete-document"
                onClick={cancelDeleteDocument}
                onFocus={() => setSelectedDeleteDocumentAction("cancel")}
                ref={cancelDeleteButtonRef}
                type="button"
              >
                Cancel
              </button>
              <button
                aria-pressed={selectedDeleteDocumentAction === "delete"}
                className={`min-w-[7.5rem] rounded-[var(--fc-radius-pill)] bg-[var(--fc-color-text)] px-5 py-2.5 font-[var(--fc-font-ui)] text-sm text-[var(--fc-color-on-dark)] outline-none transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)] hover:-translate-y-[1px] ${
                  selectedDeleteDocumentAction === "delete"
                    ? "shadow-[var(--fc-shadow-elevated)] ring-2 ring-[var(--fc-color-text)] ring-offset-2 ring-offset-[var(--fc-color-surface)]"
                    : "shadow-[var(--fc-shadow-soft)]"
                }`}
                data-testid="confirm-delete-document"
                onClick={() => void commitDeleteDocument()}
                onFocus={() => setSelectedDeleteDocumentAction("delete")}
                ref={confirmDeleteButtonRef}
                type="button"
              >
                Move to Trash
              </button>
            </div>
          </div>
        </OverlayShell>
      ) : null}
    </section>
  );
}
