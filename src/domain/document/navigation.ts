import type { CardRecord } from "./types";

function sortedChildren(cards: CardRecord[], parentId: string | null) {
  return cards
    .filter((card) => card.parentId === parentId)
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id));
}

function rootCard(cards: CardRecord[]) {
  return cards.find((card) => card.parentId === null) ?? null;
}

export function visibleCardIds(cards: CardRecord[]) {
  const root = rootCard(cards);

  if (!root) {
    return [];
  }

  const orderedIds: string[] = [];
  const stack = [root.id];

  while (stack.length > 0) {
    const currentCardId = stack.pop()!;
    orderedIds.push(currentCardId);

    const children = sortedChildren(cards, currentCardId);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!.id);
    }
  }

  return orderedIds;
}

export function parentCardId(cards: CardRecord[], cardId: string) {
  return cards.find((card) => card.id === cardId)?.parentId ?? null;
}

export function navigationBoundaryCardId(
  cards: CardRecord[],
  cardId: string,
  direction: "up" | "down" | "left",
) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  let current = byId.get(cardId);
  if (!current) return null;
  if (direction !== "left") {
    const siblings = sortedChildren(cards, current.parentId);
    return siblings[direction === "up" ? 0 : siblings.length - 1]?.id ?? null;
  }
  const visited = new Set<string>();
  while (current.parentId !== null) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    current = byId.get(current.parentId);
    if (!current) return null;
  }
  return current.id;
}

export function firstChildCardId(cards: CardRecord[], cardId: string) {
  return sortedChildren(cards, cardId)[0]?.id ?? null;
}

export function preferredChildCardId(
  cards: CardRecord[],
  cardId: string,
  rememberedChildIds: Record<string, string>,
) {
  const rememberedId = rememberedChildIds[cardId];
  return cards.some((card) => card.id === rememberedId && card.parentId === cardId)
    ? rememberedId!
    : firstChildCardId(cards, cardId);
}

export function previousSiblingCardId(cards: CardRecord[], cardId: string) {
  const currentCard = cards.find((card) => card.id === cardId);

  if (!currentCard) {
    return null;
  }

  const siblings = sortedChildren(cards, currentCard.parentId);
  const index = siblings.findIndex((card) => card.id === cardId);

  if (index <= 0) {
    return null;
  }

  return siblings[index - 1]?.id ?? null;
}

export function nextSiblingCardId(cards: CardRecord[], cardId: string) {
  const currentCard = cards.find((card) => card.id === cardId);

  if (!currentCard) {
    return null;
  }

  const siblings = sortedChildren(cards, currentCard.parentId);
  const index = siblings.findIndex((card) => card.id === cardId);

  if (index === -1 || index >= siblings.length - 1) {
    return null;
  }

  return siblings[index + 1]?.id ?? null;
}

export function previousVisibleCardId(cards: CardRecord[], cardId: string) {
  const orderedIds = visibleCardIds(cards);
  const index = orderedIds.indexOf(cardId);

  if (index <= 0) {
    return null;
  }

  return orderedIds[index - 1] ?? null;
}

export function nextVisibleCardId(cards: CardRecord[], cardId: string) {
  const orderedIds = visibleCardIds(cards);
  const index = orderedIds.indexOf(cardId);

  if (index === -1 || index >= orderedIds.length - 1) {
    return null;
  }

  return orderedIds[index + 1] ?? null;
}
