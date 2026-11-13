import type { CardRecord } from "./types";

/** Counts descendants in the full tree, excluding each card itself. */
export function buildDescendantCountMap(cards: CardRecord[]) {
  const counts: Record<string, number> = {};
  const children = new Map<string | null, CardRecord[]>();
  for (const card of cards) {
    counts[card.id] = 0;
    const siblings = children.get(card.parentId) ?? [];
    siblings.push(card);
    children.set(card.parentId, siblings);
  }

  const pending = [...(children.get(null) ?? [])];
  const traversal: CardRecord[] = [];
  while (pending.length > 0) {
    const card = pending.pop()!;
    traversal.push(card);
    pending.push(...(children.get(card.id) ?? []));
  }
  // Children contribute their entire subtree once, before their parent does.
  for (let index = traversal.length - 1; index >= 0; index -= 1) {
    const card = traversal[index]!;
    if (card.parentId !== null) {
      counts[card.parentId] = counts[card.parentId]! + counts[card.id]! + 1;
    }
  }
  return counts;
}
