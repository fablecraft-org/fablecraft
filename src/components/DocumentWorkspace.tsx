import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type WheelEvent as ReactWheelEvent } from "react";
import { CardEditor } from "./CardEditor";
import { OverlayShell } from "./OverlayShell";
import { TreeCardButton } from "./TreeCardButton";
import { buildCardNumberMap } from "../domain/document/cardNumbers";
import {
  CARD_CLIPBOARD_MIME_TYPE,
  createCardCopyPayload,
  createCardCutPayload,
  decodeCardClipboardPayload,
  encodeCardClipboardPayload,
  pasteCardClipboardPayload,
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
import { EMPTY_EDITOR_DOCUMENT_JSON, NEW_CARD_EDITOR_DOCUMENT_JSON } from "../domain/document/editorDocument";
import {
  firstChildCardId,
  parentCardId,
} from "../domain/document/navigation";
import { ancestorsOfCard, nextCardInColumn, overviewTreeLayout, previousCardInColumn, stageLayout } from "../domain/document/spatial";
import { splitCardContentAtTextOffset } from "../domain/document/split";
import { createChildCard, createSiblingAfter, createSiblingBefore, deleteCardSubtree, indentCardUnderPreviousSibling, mergeCardWithNextSibling, mergeCardWithPreviousSibling, moveCardWithinParent, outdentCard, unwrapCard, wrapLevelInParent } from "../domain/document/tree";
import { listenForFrontendMenuActions, type NativeMenuAction } from "../lib/nativeMenu";
import { randomId } from "../lib/randomId";
import { loadCurrentDocumentSnapshot } from "../storage/documentSnapshots";
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
import { useInteractionStore } from "../state/interactionStore";
import { useSettingsStore } from "../state/settingsStore";
import { resolveUiMetrics, type UiPreferences } from "../styles/tokens";
import type { DocumentSnapshot } from "../domain/document/types";
import type { DocumentSummary } from "../types/document";

interface DocumentWorkspaceProps {
  disableScrollPan?: boolean;
  document: DocumentSummary;
  onDocumentCreated?: (document: DocumentSummary) => void;
  onDocumentDeleted?: (path: string) => void;
  onDocumentRenamed?: (document: DocumentSummary, previousPath: string) => void;
  onOpenDocumentPath?: (path: string) => Promise<void> | void;
  suspendKeyboard?: boolean;
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
const ACTIVE_CARD_VIEWPORT_BUFFER = 48;
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

function fallbackCardIdAfterDelete(snapshot: DocumentSnapshot, cardId: string) {
  return (
    nextCardInColumn(snapshot.cards, cardId) ??
    previousCardInColumn(snapshot.cards, cardId) ??
    parentCardId(snapshot.cards, cardId) ??
    null
  );
}

function fallbackCardIdAfterEmptyAbandon(snapshot: DocumentSnapshot, cardId: string) {
  return (
    parentCardId(snapshot.cards, cardId) ??
    fallbackCardIdAfterDelete(snapshot, cardId)
  );
}

export function DocumentWorkspace({
  disableScrollPan = false,
  document,
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentRenamed,
  onOpenDocumentPath,
  suspendKeyboard = false,
}: DocumentWorkspaceProps) {
  const activeCardShellRef = useRef<HTMLDivElement | null>(null);
  const cardClipboardFallbackRef = useRef<{
    payload: CardClipboardPayload;
    text: string;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const tabKeyHeldRef = useRef(false);
  const previousCenterTargetRef = useRef<{
    activeCardId: string | null;
    documentId: string;
  } | null>(null);
  const wheelPanSuppressedUntilRef = useRef(0);
  const wrappedParentSourceChildRef = useRef<Record<string, string>>({});
  const [pendingEditorFocusPlacement, setPendingEditorFocusPlacement] =
    useState<EditorFocusPlacement | null>(null);
  const [pendingEditorTextInput, setPendingEditorTextInput] = useState<string | null>(null);
  const [isOverviewMode, setIsOverviewMode] = useState(false);
  const [stageOffset, setStageOffset] = useState({ x: 0, y: 0 });
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [workspaceViewportHeight, setWorkspaceViewportHeight] =
    useState(viewportHeight);
  const [directory, setDirectory] = useState<FableDirectory | null>(null);
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
  const activeCardId = useInteractionStore((state) => state.activeCardId);
  const setActiveCardId = useInteractionStore((state) => state.setActiveCardId);
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);
  const setNotice = useAppStore((state) => state.setNotice);
  const uiPreferences = useSettingsStore((state) => state.preferences);
  const applyNavigationChange = useDocumentStore(
    (state) => state.applyNavigationChange,
  );
  const hydrateSnapshot = useDocumentStore((state) => state.hydrateSnapshot);
  const redoNavigation = useDocumentStore((state) => state.redoNavigation);
  const redoEditing = useDocumentStore((state) => state.redoEditing);
  const snapshot = useDocumentStore((state) => state.snapshot);
  const undoNavigation = useDocumentStore((state) => state.undoNavigation);
  const undoEditing = useDocumentStore((state) => state.undoEditing);
  const updateSnapshot = useDocumentStore((state) => state.updateSnapshot);
  const updateSummary = useDocumentStore((state) => state.updateSummary);
  const uiMetrics = resolveUiMetrics(uiPreferences);

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

  useDocumentAutosave();
  useExternalDocumentReload(document);

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const nextSnapshot = await loadCurrentDocumentSnapshot();

        if (!cancelled) {
          hydrateSnapshot(nextSnapshot);
        }
      } catch (error) {
        console.error(error);
      }
    }

    void loadSnapshot();

    return () => {
      cancelled = true;
    };
  }, [document.documentId, hydrateSnapshot]);

  useEffect(() => {
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
  }, [document.documentId]);

  const activeSnapshot =
    snapshot?.summary.documentId === document.documentId ? snapshot : null;
  const isExplorerSelectionActive = explorerSelection.kind !== "card";
  const selectedDirectoryEntry =
    explorerSelection.kind === "entry"
      ? directory?.entries.find((entry) => entry.path === explorerSelection.path) ?? null
      : explorerSelection.kind === "preview-entry"
        ? directory?.entries.find((entry) => entry.path === explorerSelection.parentPath) ?? null
        : explorerSelection.kind === "card" && explorerSelection.parentPath
          ? directory?.entries.find((entry) => entry.path === explorerSelection.parentPath) ?? null
      : null;
  const directoryEntries = directory?.entries ?? [];
  const previewDirectoryEntries = previewDirectory?.entries ?? [];
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
  const measuredCardHeights =
    activeSnapshot
      ? Object.fromEntries(
          activeSnapshot.cards
            .map((card) => {
              const cachedHeight = cardHeights[cardHeightCacheKey(card.id)];
              const estimatedHeight = estimateRichCardHeight(
                cardContent(activeSnapshot, card.id),
                uiMetrics,
                uiPreferences,
              );

              return [
                card.id,
                cachedHeight ?? estimatedHeight,
              ];
            })
        )
      : {};
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
  const normalStageLayoutResult =
    activeSnapshot && activeCardId && !isOverviewMode
      ? stageLayout(activeSnapshot.cards, activeCardId, {
          cardHeight: uiMetrics.cardHeight,
          cardHeights: measuredCardHeights,
          cardWidth: uiMetrics.cardWidth,
          spacing: uiMetrics.spacing,
        })
      : { cards: [], emptyChildGap: null };
  const overviewLayoutResult =
    activeSnapshot && activeCardId && isOverviewMode
      ? overviewTreeLayout(activeSnapshot.cards, activeCardId, {
          cardHeight: overviewMetrics.cardHeight,
          cardWidth: overviewMetrics.cardWidth,
          columnGap: OVERVIEW_COLUMN_GAP,
          maxSiblingCenterGap: OVERVIEW_MAX_SIBLING_CENTER_GAP,
          preferredSiblingCenterGap: OVERVIEW_PREFERRED_SIBLING_CENTER_GAP,
          siblingGap: OVERVIEW_SIBLING_GAP,
        })
      : { cards: [], connectors: [] };
  const stageCards = isOverviewMode
    ? overviewLayoutResult.cards
    : normalStageLayoutResult.cards;
  const positionedCards =
    activeSnapshot
      ? stageCards.map((position) => ({
          ...position,
          contentJson: cardContent(activeSnapshot, position.cardId),
          parentId:
            activeSnapshot.cards.find((card) => card.id === position.cardId)
              ?.parentId ?? null,
        }))
      : [];
  const columnWidth = uiMetrics.cardWidth + uiMetrics.spacing;
  const explorerCardWidth = Math.round(uiMetrics.cardWidth / 2);
  const explorerGap = uiMetrics.spacing;
  const explorerColumnWidth = explorerCardWidth + explorerGap;
  const explorerToDocumentOffset =
    explorerCardWidth / 2 + uiMetrics.cardWidth / 2 + explorerGap;
  const cardColumnShift =
    explorerSelection.kind === "current-document" ||
    (explorerSelection.kind === "preview-entry" &&
      selectedPreviewEntry?.path === document.path)
      ? explorerToDocumentOffset
      : 0;
  const shouldShowDocumentTree =
    explorerSelection.kind !== "folder" &&
    explorerSelection.kind !== "entry" &&
    !(
      explorerSelection.kind === "preview-entry" &&
      selectedPreviewEntry?.path !== document.path
    );
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
      return index * explorerRowGap;
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
      return index * explorerRowGap;
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
    (explorerSelection.kind === "current-document" && !currentDocumentDirectoryEntry) ||
    (explorerSelection.kind === "card" && !selectedPreviewEntry);
  const shouldRenderPreviewEntryColumn =
    selectedDirectoryEntry?.kind === "folder" &&
    (explorerSelection.kind === "entry" ||
      explorerSelection.kind === "preview-entry" ||
      (explorerSelection.kind === "card" && Boolean(selectedPreviewEntry)));
  const shouldRenderPreviewEntryFallback =
    explorerSelection.kind === "card" &&
    selectedPreviewEntry &&
    !shouldRenderPreviewEntryColumn;
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
  const emptyChildGap = isOverviewMode ? null : normalStageLayoutResult.emptyChildGap;
  const overviewConnectors = isOverviewMode ? overviewLayoutResult.connectors : [];
  const stagePanLimit = positionedCards.reduce(
    (limits, card) => ({
      x: Math.max(limits.x, Math.abs(card.x) + layoutMetrics.cardWidth),
      y: Math.max(limits.y, Math.abs(card.y) + card.height),
    }),
    { x: layoutMetrics.cardWidth, y: layoutMetrics.cardHeight },
  );
  if (directory && !isOverviewMode) {
    stagePanLimit.x = Math.max(
      stagePanLimit.x,
      explorerToDocumentOffset +
        columnWidth +
        explorerColumnWidth * 3,
    );
    stagePanLimit.y = Math.max(stagePanLimit.y, explorerPanLimit, previewPanLimit);
  }
  if (emptyChildGap && !isOverviewMode) {
    stagePanLimit.x = Math.max(stagePanLimit.x, Math.abs(emptyChildGap.x) + layoutMetrics.cardWidth);
    stagePanLimit.y = Math.max(stagePanLimit.y, Math.abs(emptyChildGap.y) + emptyChildGap.height);
  }
  const overviewScale = isOverviewMode ? OVERVIEW_SCALE : 1;
  const isEditingSelectedCard = mode === "editing";
  const cardNumbers = activeSnapshot ? buildCardNumberMap(activeSnapshot) : {};
  const highlightedOverviewConnectorChildIds = new Set(
    activeSnapshot && activeCardId && isOverviewMode
      ? [
          activeCardId,
          ...ancestorsOfCard(activeSnapshot.cards, activeCardId).map(
            (ancestor) => ancestor.id,
          ),
        ]
      : [],
  );
  const highlightedOverviewConnectorParentIds = new Set(
    activeSnapshot && activeCardId && isOverviewMode
      ? [
          activeCardId,
          ...descendantCardIds(activeSnapshot.cards, activeCardId),
        ]
      : [],
  );
  const isSelectedCardNewEmptyHeading =
    selectedCardContent === NEW_CARD_EDITOR_DOCUMENT_JSON;
  const activeHorizontalPadding = 33;
  const activeTopPadding = isSelectedCardNewEmptyHeading ? 33 : 40;
  const activeBottomPadding = isSelectedCardNewEmptyHeading ? 33 : 23;

  function focusCardForEditing(
    nextCardId: string | null,
    placement: EditorFocusPlacement = "end",
    textInput: string | null = null,
  ) {
    if (!nextCardId) {
      return false;
    }

    setActiveCardId(nextCardId);
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

  async function createDocumentInCurrentDirectory() {
    if (!directory) {
      return;
    }

    try {
      const nextDocument = await createUntitledDocumentInDirectory(directory.folderPath);
      onDocumentCreated?.(nextDocument);
      setDirectory(await listCurrentDocumentDirectory());
      selectExplorer({ kind: "card" });
      setMode("editing");
    } catch (error) {
      console.error(error);
      setDirectoryLoadError(
        error instanceof Error ? error.message : "Could not create document.",
      );
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

    try {
      const nextDocument = await renameFableDocument(previousPath, renameDraft);
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
    if (!pendingDeleteDocument) {
      return;
    }

    const deletedDocument = pendingDeleteDocument;

    try {
      await deleteFableDocument(deletedDocument.path);
      setPendingDeleteDocument(null);
      setDocumentDeleteError(null);

      if (deletedDocument.path === document.path) {
        onDocumentDeleted?.(deletedDocument.path);
        return;
      }

      await refreshDirectoryAfterDelete(deletedDocument.path);
      setNotice({
        tone: "info",
        message: `Deleted "${deletedDocument.name}".`,
      });
    } catch (error) {
      console.error(error);
      setDocumentDeleteError(
        error instanceof Error ? error.message : "Could not delete document.",
      );
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

  async function selectFirstVisibleChildOfFolder(entry: FableDirectoryEntry) {
    if (entry.kind !== "folder") {
      return false;
    }

    try {
      const nextPreviewDirectory =
        previewDirectory?.folderPath === entry.path
          ? previewDirectory
          : await listFableDirectory(entry.path);
      const firstVisibleChild = nextPreviewDirectory.entries[0];

      setPreviewDirectory(nextPreviewDirectory);

      if (!firstVisibleChild) {
        await openDirectory(entry.path);
        return true;
      }

      selectExplorer({
        kind: "preview-entry",
        parentPath: entry.path,
        path: firstVisibleChild.path,
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
      const rootId = firstRootCardId();

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

  function createParentLevel() {
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

  function canHandleCardClipboard() {
    return (
      !suspendKeyboard &&
      !pendingDeleteDocument &&
      mode === "navigation" &&
      explorerSelection.kind === "card" &&
      Boolean(activeSnapshot && activeCardId)
    );
  }

  function handleFrontendMenuAction(action: NativeMenuAction) {
    if (
      !activeSnapshot ||
      !activeCardId
    ) {
      return;
    }

    if (action === "zoom-in" || action === "zoom-out") {
      if (suspendKeyboard || mode === "search") {
        return;
      }

      if (action === "zoom-in") {
        exitOverviewMode();
      } else {
        enterOverviewMode();
      }
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
      if (mode === "editing") {
        undoEditing();
      } else {
        undoNavigation();
      }
      return;
    }

    if (action === "redo") {
      if (mode === "editing") {
        redoEditing();
      } else {
        redoNavigation();
      }
      return;
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

    const nextActiveCardId =
      activeCardId &&
      activeSnapshot.cards.some((card) => card.id === activeCardId)
        ? activeCardId
        : activeSnapshot.cards.find((card) => card.parentId === null)?.id ?? null;

    setActiveCardId(nextActiveCardId);
  }, [activeCardId, activeSnapshot, setActiveCardId]);

  useLayoutEffect(() => {
    const previousCenterTarget = previousCenterTargetRef.current;
    const centerTargetChanged =
      previousCenterTarget !== null &&
      (previousCenterTarget.activeCardId !== activeCardId ||
        previousCenterTarget.documentId !== document.documentId);

    previousCenterTargetRef.current = {
      activeCardId,
      documentId: document.documentId,
    };

    if (centerTargetChanged) {
      wheelPanSuppressedUntilRef.current =
        Date.now() + RECENTER_WHEEL_SUPPRESSION_MS;
    }

    setStageOffset({ x: 0, y: 0 });
  }, [activeCardId, document.documentId]);

  useEffect(() => {
    setIsOverviewMode(false);
  }, [document.documentId]);

  useEffect(() => {
    function updateViewportHeight() {
      setWorkspaceViewportHeight(viewportHeight());
    }

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);

    return () => {
      window.removeEventListener("resize", updateViewportHeight);
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

  function enterOverviewMode() {
    setStageOffset({ x: 0, y: 0 });
    setPendingEditorFocusPlacement(null);
    setPendingEditorTextInput(null);
    setIsOverviewMode(true);
    setMode("navigation");
  }

  function exitOverviewMode() {
    setStageOffset({ x: 0, y: 0 });
    setPendingEditorFocusPlacement(null);
    setPendingEditorTextInput(null);
    setIsOverviewMode(false);
    setMode("navigation");
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
      if (event.defaultPrevented || suspendKeyboard) {
        return;
      }

      if (mode === "search" || mode === "command") {
        return;
      }

      if (pendingDeleteDocument) {
        return;
      }

      if (renamingDocumentPath) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        enterOverviewMode();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "+" || event.key === "=")
      ) {
        event.preventDefault();
        exitOverviewMode();
        return;
      }

      if (isOverviewMode && event.key === "Enter") {
        event.preventDefault();
        exitOverviewMode();
        return;
      }

      if (mode === "navigation" && explorerSelection.kind !== "card") {
        if (event.key === "Enter" && selectedRenamableDocument) {
          event.preventDefault();
          startRenamingSelectedDocument();
          return;
        }

        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "ArrowRight" &&
          explorerSelection.kind === "folder"
        ) {
          event.preventDefault();
          void createDocumentInCurrentDirectory();
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();

          if (explorerSelection.kind === "current-document") {
            selectExplorer({ kind: "folder" });
            return;
          }

          if (explorerSelection.kind === "entry") {
            selectExplorer({ kind: "folder" });
            return;
          }

          if (explorerSelection.kind === "preview-entry") {
            selectExplorer({
              kind: "entry",
              path: explorerSelection.parentPath,
            });
            return;
          }

          if (explorerSelection.kind === "folder" && directory?.parentFolderPath) {
            void openDirectory(directory.parentFolderPath);
          }
          return;
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();

          if (explorerSelection.kind === "current-document") {
            const rootId = firstRootCardId();

            if (rootId) {
              setActiveCardId(rootId);
            }
            selectExplorer({ kind: "card" });
            return;
          }

          if (explorerSelection.kind === "folder") {
            selectEntryAtIndex(0);
            return;
          }

          if (explorerSelection.kind === "entry") {
            if (selectedDirectoryEntry?.kind === "folder") {
              void selectFirstVisibleChildOfFolder(selectedDirectoryEntry);
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
              const rootId = firstRootCardId();

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
            currentIndex === -1
              ? fallbackIndex
              : Math.max(0, Math.min(activeEntries.length - 1, currentIndex + direction));

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
        setPendingEditorFocusPlacement("end");
        setPendingEditorTextInput(null);
        setMode("editing");
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        tabKeyHeldRef.current = true;
        return;
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

      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight")
      ) {
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
          ? parentCardId(currentSnapshot.cards, currentCardId)
          : event.key === "ArrowRight"
            ? firstChildCardId(currentSnapshot.cards, currentCardId)
            : event.key === "ArrowUp"
              ? previousCardInColumn(currentSnapshot.cards, currentCardId)
              : event.key === "ArrowDown"
                ? nextCardInColumn(currentSnapshot.cards, currentCardId)
                : null;

      if (!nextCardId) {
        if (
          event.key === "ArrowLeft" &&
          selectedCard?.parentId === null &&
          directory
        ) {
          event.preventDefault();
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
      setActiveCardId(nextCardId);
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
    activeSnapshot,
    applyNavigationChange,
    directory,
    directoryEntries,
    explorerSelection,
    isOverviewMode,
    mode,
    previewDirectoryEntries,
    pendingDeleteDocument,
    redoNavigation,
    redoEditing,
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
    activeCardId,
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
      if (!canHandleCardClipboard() || !activeSnapshot || !activeCardId) {
        return;
      }

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
      if (!canHandleCardClipboard() || !activeSnapshot || !activeCardId) {
        return;
      }

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
      if (!canHandleCardClipboard() || !activeSnapshot || !activeCardId) {
        return;
      }

      const payload = readCardClipboardPayload(event);

      if (!payload) {
        event.preventDefault();
        setNotice({
          tone: "error",
          message: "Clipboard does not contain a Fablecraft card.",
        });
        return;
      }

      try {
        const nextSnapshot = pasteCardClipboardPayload(
          activeSnapshot,
          activeCardId,
          payload,
          () => randomId("card"),
        );

        event.preventDefault();
        applyNavigationChange(() => nextSnapshot);
        setActiveCardId(activeCardId);
        setPendingEditorFocusPlacement(null);
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

    window.addEventListener("copy", handleCopy);
    window.addEventListener("cut", handleCut);
    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("cut", handleCut);
      window.removeEventListener("paste", handlePaste);
    };
  }, [
    activeCardId,
    activeSnapshot,
    applyNavigationChange,
    explorerSelection.kind,
    mode,
    pendingDeleteDocument,
    setActiveCardId,
    setNotice,
    suspendKeyboard,
  ]);

  return (
    <section className="relative flex h-full w-full items-stretch overflow-hidden">
      <div
        data-testid="document-stage"
        className="relative h-full w-full overflow-hidden"
        onWheel={handleStageWheel}
      >
        {directory && !isOverviewMode ? (
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
            {explorerSelection.kind !== "preview-entry" &&
            explorerSelection.kind !== "card" ? (
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
            {(explorerSelection.kind === "preview-entry" ||
              (explorerSelection.kind === "card" && selectedPreviewEntry)) &&
            selectedDirectoryEntry ? (
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
                x={
                  explorerSelection.kind === "card"
                    ? -explorerToDocumentOffset - explorerColumnWidth + stageOffset.x
                    : -explorerColumnWidth + stageOffset.x
                }
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
                      : explorerSelection.kind === "card"
                        ? -explorerToDocumentOffset + stageOffset.x
                        : stageOffset.x
                  }
                  y={previewEntryY(index) + stageOffset.y}
                />
              ))
            ) : null}
            {shouldRenderPreviewEntryFallback ? (
              <ExplorerCard
                isActive={false}
                kind={selectedPreviewEntry.kind === "folder" ? "folder" : "document"}
                label={explorerLabelForEntry(selectedPreviewEntry)}
                meta={selectedPreviewEntry.kind === "folder" ? "FOLDER" : "FABLE"}
                onClick={() => {
                  selectExplorer({
                    kind: "preview-entry",
                    parentPath: explorerSelection.parentPath ?? "",
                    path: selectedPreviewEntry.path,
                  });
                  setMode("navigation");
                }}
                width={explorerCardWidth}
                {...(selectedPreviewEntry.kind === "document"
                  ? renamePropsForDocument(selectedPreviewEntry.path)
                  : {})}
                x={-explorerToDocumentOffset + stageOffset.x}
                y={stageOffset.y}
              />
            ) : null}
          </>
        ) : null}
        {directoryLoadError && !isOverviewMode ? (
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
        {isOverviewMode && overviewConnectors.length > 0 ? (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px overflow-visible"
            data-testid="overview-connectors"
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
                  connector.parentCardId === activeCardId ||
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
                  connector.parentCardId === activeCardId ||
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
        {shouldShowDocumentTree ? positionedCards.map((card) => {
          if (
            uiPreferences.neighborCards === "hidden" &&
            !isOverviewMode &&
            !card.isActive
          ) {
            return null;
          }

          const displayX = card.x + cardColumnShift + stageOffset.x;
          const displayY = card.y + stageOffset.y;
          const activeCardOverflowsViewport =
            !isOverviewMode &&
            card.isActive &&
            card.height >
              workspaceViewportHeight - ACTIVE_CARD_VIEWPORT_BUFFER * 2;
          const activeCardTop = activeCardOverflowsViewport
            ? isEditingSelectedCard
              ? workspaceViewportHeight -
                ACTIVE_CARD_VIEWPORT_BUFFER -
                card.height +
                displayY
              : ACTIVE_CARD_VIEWPORT_BUFFER + displayY
            : null;

          return (
                !isOverviewMode &&
                card.isActive &&
                !isExplorerSelectionActive &&
                selectedCard &&
                selectedCardContent ? (
                  <div
                    data-testid="active-card-shell"
                    className="absolute flex w-[var(--fc-card-width)] flex-col justify-start border bg-[var(--fc-color-card-surface-active)] px-5 py-[10px] transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
                    ref={activeCardShellRef}
                    key={card.cardId}
                    onClick={() => setMode("editing")}
                    role="presentation"
                    style={{
                      backgroundColor: isEditingSelectedCard
                        ? "var(--fc-color-card-surface-editing)"
                        : "var(--fc-color-card-surface-active)",
                      borderColor: "transparent",
                      borderWidth: "0px",
                      boxShadow: "var(--fc-shadow-elevated)",
                      left: `calc(50% + ${displayX}px)`,
                      minHeight: `${card.height}px`,
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
                    {selectedCard.parentId ? (
                      <p className="pointer-events-none absolute left-[28px] top-[18px] font-[var(--fc-font-ui)] text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fc-color-card-label)]">
                        {cardNumbers[selectedCard.parentId] ??
                          selectedCard.parentId.toUpperCase()}
                      </p>
                    ) : null}
                    <p className="pointer-events-none absolute right-[28px] top-[18px] font-[var(--fc-font-ui)] text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fc-color-card-label)]">
                      {cardNumbers[selectedCard.id] ?? selectedCard.id.toUpperCase()}
                    </p>
                    <CardEditor
                      canLeaveEditing={canLeaveEditing}
                      canCreateStructure={canCreateStructure}
                      focusPlacement={pendingEditorFocusPlacement}
                      key={selectedCard.id}
                      contentJson={selectedCardContent}
                      isEditing={mode === "editing"}
                      onConsumeFocusPlacement={() => setPendingEditorFocusPlacement(null)}
                      onConsumePendingTextInput={() => setPendingEditorTextInput(null)}
                      onCreateBelow={() => {
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

                          return replaceCardContent(nextSnapshot, {
                            cardId: selectedCard.id,
                            contentJson: trimTrailingEmptyParagraphs(
                              cardContent(nextSnapshot, selectedCard.id),
                            ),
                          });
                        });
                        focusCardForEditing(newCardId, "end");
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
                      onSplitAtSelection={(selectionStart, selectionEnd) => {
                        const splitContent = splitCardContentAtTextOffset(
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
                  </div>
                ) : (
                  <TreeCardButton
                    borderColor="transparent"
                    cardWidth={isOverviewMode ? OVERVIEW_CARD_WIDTH : undefined}
                    cardLabel={cardNumbers[card.cardId] ?? card.cardId.toUpperCase()}
                    contentJson={card.contentJson}
                    parentCardLabel={
                      card.parentId
                        ? cardNumbers[card.parentId] ?? card.parentId.toUpperCase()
                        : undefined
                    }
                    placeholder={
                      !isFirstRootCardId(card.cardId) &&
                      isContentEffectivelyEmpty(card.contentJson)
                        ? "empty card"
                        : ""
                    }
                    isActive={card.isActive && !isExplorerSelectionActive}
                    minHeight={isOverviewMode ? OVERVIEW_CARD_HEIGHT : undefined}
                    key={card.cardId}
                    onMeasureHeight={(height) => {
                      if (isOverviewMode) {
                        return;
                      }

                      updateCardHeight(card.cardId, height, true);
                    }}
                    onClick={() => {
                      preserveDocumentTreeExplorerContext();
                      setActiveCardId(card.cardId);
                      setPendingEditorFocusPlacement(isOverviewMode ? null : "end");
                      setPendingEditorTextInput(null);
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
      {pendingDeleteDocument ? (
        <OverlayShell
          onBackdropMouseDown={cancelDeleteDocument}
          title="Delete Document"
          widthClassName="max-w-[min(92vw,520px)]"
        >
          <div className="space-y-7">
            <p className="font-[var(--fc-font-content)] text-[1.05rem] leading-7 text-[var(--fc-color-text)]">
              Are you sure you want to delete "{pendingDeleteDocument.name}" and all of it's contents?
            </p>
            {documentDeleteError ? (
              <p
                className="font-[var(--fc-font-ui)] text-sm leading-6 text-red-600"
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
                Delete
              </button>
            </div>
          </div>
        </OverlayShell>
      ) : null}
    </section>
  );
}
