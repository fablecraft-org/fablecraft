import { removeCutSubtree } from "./clipboard";
import { cardContent, contentText } from "./content";
import { normalizeDocumentSnapshot } from "./serialization";
import type { CardRecord, DocumentSnapshot } from "./types";
import type { DocumentSummary } from "../../types/document";

function orderedChildren(cards: CardRecord[], parentId: string) {
  return cards
    .filter((card) => card.parentId === parentId)
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id));
}

function orderedSubtreeCards(cards: CardRecord[], cardId: string) {
  const rootCard = cards.find((card) => card.id === cardId);

  if (!rootCard) {
    throw new Error(`Unable to convert missing card ${cardId}.`);
  }

  const subtreeCards: CardRecord[] = [rootCard];
  const queue = orderedChildren(cards, cardId);

  while (queue.length > 0) {
    const nextCard = queue.shift()!;

    subtreeCards.push(nextCard);
    queue.unshift(...orderedChildren(cards, nextCard.id));
  }

  return subtreeCards;
}

export function createDocumentFromCardSubtree(
  sourceSnapshot: DocumentSnapshot,
  cardId: string,
  summary: DocumentSummary,
) {
  const subtreeCards = orderedSubtreeCards(sourceSnapshot.cards, cardId);
  const subtreeIds = new Set(subtreeCards.map((card) => card.id));

  return normalizeDocumentSnapshot({
    cards: subtreeCards.map((card, index) => ({
      ...card,
      documentId: summary.documentId,
      orderIndex: card.id === cardId ? 0 : card.orderIndex,
      parentId: card.id === cardId ? null : card.parentId,
      type: "card",
    })),
    contents: sourceSnapshot.contents
      .filter((content) => subtreeIds.has(content.cardId))
      .map((content) => ({ ...content })),
    revisions: [],
    summary,
  });
}

export function removeConvertedCardFromSource(
  sourceSnapshot: DocumentSnapshot,
  cardId: string,
) {
  return removeCutSubtree(sourceSnapshot, cardId);
}

export function defaultConvertedDocumentName(
  sourceSnapshot: DocumentSnapshot,
  cardId: string,
) {
  const text = cardContent(sourceSnapshot, cardId)
    ? contentText(cardContent(sourceSnapshot, cardId))
    : "";

  const normalizedText = text
    .replace(/[#*_`>\-[\]()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");

  return normalizedText ? `${normalizedText}.fable` : "untitled.fable";
}
