import type { CardRecord, DocumentSnapshot } from "./types";
import { CARD_LINK_NODE } from "./cardLinks";

export interface AppearanceStep {
  cardId: string;
  alias: boolean;
}

export interface CardAppearance {
  id: string;
  cardId: string;
  path: AppearanceStep[];
  isAlias: boolean;
  isReference: boolean;
  missing: boolean;
}

export function appearanceId(path: AppearanceStep[]) {
  return path.some((step) => step.alias)
    ? `reference:${JSON.stringify(path)}`
    : path[path.length - 1]!.cardId;
}

function isPrefix(prefix: AppearanceStep[], path: AppearanceStep[]) {
  return prefix.length <= path.length && prefix.every((step, index) =>
    step.cardId === path[index]!.cardId && step.alias === path[index]!.alias);
}

/** Document order is the alias order; repeated mentions create only one entry. */
export function referencedCardIds(contentJson: string): string[] {
  if (!contentJson.includes(`"${CARD_LINK_NODE}"`)) return [];
  let document: unknown;
  try { document = JSON.parse(contentJson); } catch { return []; }
  const targets = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const node = value as { type?: string; attrs?: { targetCardId?: unknown }; content?: unknown[] };
    if (node.type === CARD_LINK_NODE && typeof node.attrs?.targetCardId === "string") targets.add(node.attrs.targetCardId);
    if (Array.isArray(node.content)) node.content.forEach(visit);
  }
  visit(document);
  return [...targets];
}

/**
 * A transient layout tree, never a persistence snapshot. Canonical branches retain
 * their ids. Reference branches expand only along the selected path, plus its
 * immediate children, so a dense reference graph cannot expand exponentially.
 */
export function referenceTree(
  snapshot: DocumentSnapshot,
  activeCardId: string | null,
  requestedPath: AppearanceStep[] | null = null,
) {
  const originals = new Map(snapshot.cards.map((card) => [card.id, card]));
  const children = new Map<string | null, CardRecord[]>();
  snapshot.cards.forEach((card) => {
    const group = children.get(card.parentId) ?? [];
    group.push(card);
    children.set(card.parentId, group);
  });
  children.forEach((group) => group.sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id)));
  const targets = new Map(snapshot.contents.map((content) => [content.cardId, referencedCardIds(content.contentJson)]));
  // Real ancestors are excluded even when the source is viewed through an alias.
  targets.forEach((ids, sourceId) => {
    const ancestors = new Set<string>();
    let parentId = originals.get(sourceId)?.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = originals.get(parentId)?.parentId;
    }
    targets.set(sourceId, ids.filter((id) => !ancestors.has(id)));
  });
  const appearances = new Map<string, CardAppearance>();
  const cards: CardRecord[] = [];
  const preferredChildren: Record<string, string> = {};

  function add(cardId: string, path: AppearanceStep[], parentId: string | null, orderIndex: number, alias: boolean): string | null {
    if (path.filter((step) => step.cardId === cardId).length >= 2) return null;
    const nextPath = [...path, { cardId, alias }];
    const id = appearanceId(nextPath);
    const original = originals.get(cardId);
    const isReference = nextPath.some((step) => step.alias);
    appearances.set(id, { id, cardId, path: nextPath, isAlias: alias, isReference, missing: !original });
    cards.push({ id, parentId, orderIndex, documentId: snapshot.summary.documentId, type: "card" });
    if (!original || (isReference && !isPrefix(nextPath, requestedPath ?? []))) return id;

    const aliases = targets.get(cardId) ?? [];
    let firstAlias: string | null = null;
    aliases.forEach((target, index) => {
      const child = add(target, nextPath, id, index - aliases.length, true);
      firstAlias ??= child;
    });
    let firstOwned: string | null = null;
    (children.get(cardId) ?? []).forEach((child) => {
      const owned = add(child.id, nextPath, id, child.orderIndex, false);
      firstOwned ??= owned;
    });
    // Override remembered-child routing only for reference branches or sources
    // with visible aliases. Unlinked canonical tree navigation stays unchanged.
    if (firstAlias || isReference) {
      const preferred = firstOwned ?? firstAlias;
      if (preferred) preferredChildren[id] = preferred;
    }
    return id;
  }
  (children.get(null) ?? []).forEach((root) => add(root.id, [], null, root.orderIndex, false));

  const requestedId = requestedPath?.length ? appearanceId(requestedPath) : activeCardId;
  let activeId = requestedId && appearances.has(requestedId) ? requestedId : null;
  if (!activeId && requestedPath) {
    for (let length = requestedPath.length - 1; length > 0; length -= 1) {
      const candidate = appearanceId(requestedPath.slice(0, length));
      if (appearances.has(candidate)) { activeId = candidate; break; }
    }
  }
  activeId ??= activeCardId && appearances.has(activeCardId) ? activeCardId : cards[0]?.id ?? null;
  return { cards, appearances, preferredChildren, activeId };
}
