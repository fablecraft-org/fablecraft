import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { CardEditor } from "./CardEditor";
import { TreeCardButton } from "./TreeCardButton";
import { buildCardNumberMap } from "../domain/document/cardNumbers";
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
  suspendKeyboard?: boolean;
}

type EditorFocusPlacement = "end" | "start";

const OVERVIEW_CARD_WIDTH = 236;
const OVERVIEW_CARD_HEIGHT = 72;
const OVERVIEW_COLUMN_GAP = 156;
const OVERVIEW_SCALE = 0.82;
const OVERVIEW_SIBLING_GAP = 18;
const OVERVIEW_PREFERRED_SIBLING_CENTER_GAP = 148;
const OVERVIEW_MAX_SIBLING_CENTER_GAP = 200;

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
  suspendKeyboard = false,
}: DocumentWorkspaceProps) {
  const activeCardShellRef = useRef<HTMLDivElement | null>(null);
  const tabKeyHeldRef = useRef(false);
  const wrappedParentSourceChildRef = useRef<Record<string, string>>({});
  const [pendingEditorFocusPlacement, setPendingEditorFocusPlacement] =
    useState<EditorFocusPlacement | null>(null);
  const [pendingEditorTextInput, setPendingEditorTextInput] = useState<string | null>(null);
  const [isOverviewMode, setIsOverviewMode] = useState(false);
  const [stageOffset, setStageOffset] = useState({ x: 0, y: 0 });
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const activeCardId = useInteractionStore((state) => state.activeCardId);
  const setActiveCardId = useInteractionStore((state) => state.setActiveCardId);
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);
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

  const activeSnapshot =
    snapshot?.summary.documentId === document.documentId ? snapshot : null;
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
        }))
      : [];
  const emptyChildGap = isOverviewMode ? null : normalStageLayoutResult.emptyChildGap;
  const overviewConnectors = isOverviewMode ? overviewLayoutResult.connectors : [];
  const stagePanLimit = positionedCards.reduce(
    (limits, card) => ({
      x: Math.max(limits.x, Math.abs(card.x) + layoutMetrics.cardWidth),
      y: Math.max(limits.y, Math.abs(card.y) + card.height),
    }),
    { x: layoutMetrics.cardWidth, y: layoutMetrics.cardHeight },
  );
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

  useEffect(() => {
    if (isOverviewMode) {
      return;
    }

    setStageOffset({ x: 0, y: 0 });
  }, [activeCardId, document.documentId, isOverviewMode]);

  useEffect(() => {
    setIsOverviewMode(false);
  }, [document.documentId]);

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
        return;
      }

      event.preventDefault();
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
    isOverviewMode,
    mode,
    redoNavigation,
    redoEditing,
    selectedCard?.parentId,
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

  return (
    <section className="relative flex h-full w-full items-stretch overflow-hidden">
      <div
        data-testid="document-stage"
        className="relative h-full w-full overflow-hidden"
        onWheel={handleStageWheel}
      >
        {emptyChildGap && !isOverviewMode ? (
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
        {positionedCards.map((card) => {
          const displayX = card.x + stageOffset.x;
          const displayY = card.y + stageOffset.y;

          return (
                !isOverviewMode &&
                card.isActive &&
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
                      top: `calc(50% + ${displayY}px)`,
                      transform: "translate(-50%, -50%)",
                      zIndex: 2,
                    }}
                  >
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
                    placeholder={
                      !isFirstRootCardId(card.cardId) &&
                      isContentEffectivelyEmpty(card.contentJson)
                        ? "empty card"
                        : ""
                    }
                    isActive={card.isActive}
                    isNeighborhood={card.isNeighborhood}
                    minHeight={isOverviewMode ? OVERVIEW_CARD_HEIGHT : undefined}
                    key={card.cardId}
                    onMeasureHeight={(height) => {
                      if (isOverviewMode) {
                        return;
                      }

                      updateCardHeight(card.cardId, height, true);
                    }}
                    onClick={() => {
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
            })}
      </div>
    </section>
  );
}
