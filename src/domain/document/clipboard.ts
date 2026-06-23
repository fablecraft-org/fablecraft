import { EMPTY_EDITOR_DOCUMENT_JSON } from "./editorDocument";
import { cardContent, isContentEffectivelyEmpty, replaceCardContent } from "./content";
import { normalizeDocumentSnapshot } from "./serialization";
import { deleteCardSubtree } from "./tree";
import type { CardRecord, DocumentSnapshot } from "./types";

export const CARD_CLIPBOARD_MIME_TYPE = "application/x-fablecraft-card+json";
export const CARD_CLIPBOARD_TEXT_PREFIX = "FABLECRAFT_CARD_CLIPBOARD_V1:";

interface CardClipboardSource {
  documentId: string;
  documentName: string;
  documentPath: string;
  rootCardId: string;
}

export interface CardClipboardDescendantRecord {
  contentJson: string;
  id: string;
  orderIndex: number;
  parentId: string;
  type: "card";
}

interface BaseCardClipboardPayload {
  format: "fablecraft.card";
  operation: "copy" | "cut";
  rootContentJson: string;
  source: CardClipboardSource;
  version: 1;
}

export interface CardContentClipboardPayload extends BaseCardClipboardPayload {
  kind: "content";
}

export interface CardSubtreeClipboardPayload extends BaseCardClipboardPayload {
  descendants: CardClipboardDescendantRecord[];
  kind: "subtree";
}

export type CardClipboardPayload =
  | CardContentClipboardPayload
  | CardSubtreeClipboardPayload;

export function encodeCardClipboardPayload(payload: CardClipboardPayload) {
  return `${CARD_CLIPBOARD_TEXT_PREFIX}${JSON.stringify(payload)}`;
}

export function decodeCardClipboardPayload(value: string) {
  const payloadJson = value.startsWith(CARD_CLIPBOARD_TEXT_PREFIX)
    ? value.slice(CARD_CLIPBOARD_TEXT_PREFIX.length)
    : value;

  try {
    return parseCardClipboardPayload(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

function sourceForCard(snapshot: DocumentSnapshot, cardId: string): CardClipboardSource {
  return {
    documentId: snapshot.summary.documentId,
    documentName: snapshot.summary.name,
    documentPath: snapshot.summary.path,
    rootCardId: cardId,
  };
}

function cardById(snapshot: DocumentSnapshot, cardId: string) {
  return snapshot.cards.find((card) => card.id === cardId) ?? null;
}

function orderedChildren(cards: CardRecord[], parentId: string) {
  return cards
    .filter((card) => card.parentId === parentId)
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id));
}

function orderedDescendantCards(cards: CardRecord[], cardId: string) {
  const descendants: CardRecord[] = [];
  const queue = orderedChildren(cards, cardId);

  while (queue.length > 0) {
    const nextCard = queue.shift()!;

    descendants.push(nextCard);
    queue.unshift(...orderedChildren(cards, nextCard.id));
  }

  return descendants;
}

export function createCardCopyPayload(
  snapshot: DocumentSnapshot,
  cardId: string,
): CardContentClipboardPayload {
  if (!cardById(snapshot, cardId)) {
    throw new Error(`Unable to copy missing card ${cardId}.`);
  }

  return {
    format: "fablecraft.card",
    kind: "content",
    operation: "copy",
    rootContentJson: cardContent(snapshot, cardId),
    source: sourceForCard(snapshot, cardId),
    version: 1,
  };
}

export function createCardCutPayload(
  snapshot: DocumentSnapshot,
  cardId: string,
): CardSubtreeClipboardPayload {
  if (!cardById(snapshot, cardId)) {
    throw new Error(`Unable to cut missing card ${cardId}.`);
  }

  return {
    descendants: orderedDescendantCards(snapshot.cards, cardId).map((card) => ({
      contentJson: cardContent(snapshot, card.id),
      id: card.id,
      orderIndex: card.orderIndex,
      parentId: card.parentId ?? "",
      type: "card",
    })),
    format: "fablecraft.card",
    kind: "subtree",
    operation: "cut",
    rootContentJson: cardContent(snapshot, cardId),
    source: sourceForCard(snapshot, cardId),
    version: 1,
  };
}

export function removeCutSubtree(
  snapshot: DocumentSnapshot,
  cardId: string,
) {
  const card = cardById(snapshot, cardId);

  if (!card) {
    throw new Error(`Unable to remove missing card ${cardId}.`);
  }

  const rootCards = snapshot.cards.filter((candidate) => candidate.parentId === null);
  const isOnlyRootCard = card.parentId === null && rootCards.length === 1;

  if (!isOnlyRootCard) {
    return deleteCardSubtree(snapshot, cardId);
  }

  const removedDescendantIds = new Set(
    orderedDescendantCards(snapshot.cards, cardId).map((descendant) => descendant.id),
  );

  return normalizeDocumentSnapshot(
    replaceCardContent(
      {
        ...snapshot,
        cards: snapshot.cards.filter((candidate) => !removedDescendantIds.has(candidate.id)),
        contents: snapshot.contents.filter((content) => !removedDescendantIds.has(content.cardId)),
      },
      {
        cardId,
        contentJson: EMPTY_EDITOR_DOCUMENT_JSON,
      },
    ),
  );
}

export function pasteCardClipboardPayload(
  snapshot: DocumentSnapshot,
  targetCardId: string,
  payload: CardClipboardPayload,
  createCardId: () => string,
) {
  const targetCard = cardById(snapshot, targetCardId);

  if (!targetCard) {
    throw new Error(`Unable to paste into missing card ${targetCardId}.`);
  }

  if (!isContentEffectivelyEmpty(cardContent(snapshot, targetCardId))) {
    throw new Error("Paste target must be an empty card.");
  }

  if (snapshot.cards.some((card) => card.parentId === targetCardId)) {
    throw new Error("Paste target must not already have children.");
  }

  if (payload.kind === "content") {
    return replaceCardContent(snapshot, {
      cardId: targetCardId,
      contentJson: payload.rootContentJson,
    });
  }

  const idMap = new Map<string, string>([
    [payload.source.rootCardId, targetCardId],
  ]);
  const nextCards: CardRecord[] = [];
  const nextContents = payload.descendants.map((descendant) => {
    const nextCardId = createCardId();
    const nextParentId = idMap.get(descendant.parentId);

    if (!nextParentId) {
      throw new Error("Clipboard subtree is missing a pasted parent.");
    }

    idMap.set(descendant.id, nextCardId);
    nextCards.push({
      documentId: snapshot.summary.documentId,
      id: nextCardId,
      orderIndex: descendant.orderIndex,
      parentId: nextParentId,
      type: "card",
    });

    return {
      cardId: nextCardId,
      contentJson: descendant.contentJson,
    };
  });

  return normalizeDocumentSnapshot(
    replaceCardContent(
      {
        ...snapshot,
        cards: snapshot.cards.concat(nextCards),
        contents: snapshot.contents.concat(nextContents),
      },
      {
        cardId: targetCardId,
        contentJson: payload.rootContentJson,
      },
    ),
  );
}

function parseCardClipboardPayload(value: unknown): CardClipboardPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;

  if (
    payload.format !== "fablecraft.card" ||
    payload.version !== 1 ||
    (payload.kind !== "content" && payload.kind !== "subtree") ||
    (payload.operation !== "copy" && payload.operation !== "cut") ||
    typeof payload.rootContentJson !== "string" ||
    !payload.source ||
    typeof payload.source !== "object"
  ) {
    return null;
  }

  const source = payload.source as Record<string, unknown>;

  if (
    typeof source.rootCardId !== "string" ||
    typeof source.documentId !== "string" ||
    typeof source.documentName !== "string" ||
    typeof source.documentPath !== "string"
  ) {
    return null;
  }

  if (payload.kind === "content") {
    return payload as unknown as CardContentClipboardPayload;
  }

  if (
    !Array.isArray(payload.descendants) ||
    payload.descendants.some(
      (descendant: unknown) =>
        !descendant ||
        typeof descendant !== "object" ||
        typeof (descendant as Record<string, unknown>).id !== "string" ||
        typeof (descendant as Record<string, unknown>).parentId !== "string" ||
        typeof (descendant as Record<string, unknown>).orderIndex !== "number" ||
        (descendant as Record<string, unknown>).type !== "card" ||
        typeof (descendant as Record<string, unknown>).contentJson !== "string",
    )
  ) {
    return null;
  }

  return payload as unknown as CardSubtreeClipboardPayload;
}
