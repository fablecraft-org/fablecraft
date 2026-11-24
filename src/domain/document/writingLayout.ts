import type { CardRecord } from "./types";
import type { StageLayoutResult } from "./spatial";

export interface WritingViewportTokens {
  minimumCardWidth: number;
  focusedCardWidth: number;
  maximumColumns: number;
  margin: number;
  spacing: number;
  verticalInset: number;
}

export function writingViewport(
  width: number,
  tokens: WritingViewportTokens,
  { focused = false, showParentInTwoColumns = false } = {},
) {
  const available = Math.min(focused ? tokens.focusedCardWidth : Infinity, Math.max(1, width - tokens.margin * 2));
  const columns = Math.max(1, Math.min(focused ? 1 : tokens.maximumColumns,
    Math.floor((available + tokens.spacing) / (tokens.minimumCardWidth + tokens.spacing))));
  const cardWidth = Math.max(1, (available - (columns - 1) * tokens.spacing) / columns);
  const activeColumn = columns >= 3 || (columns === 2 && showParentInTwoColumns) ? 1 : 0;
  return {
    columns,
    cardWidth,
    activeX: focused ? 0 : tokens.margin + cardWidth / 2 + activeColumn * (cardWidth + tokens.spacing) - width / 2,
    minimumDepth: activeColumn ? -activeColumn : 0,
    maximumDepth: columns - activeColumn - 1,
  };
}

// Refine the full navigation layout for the visible writing neighborhood.
// Coordinates remain relative to the viewport center; panning is applied later.
export function arrangeWritingStage(
  layout: StageLayoutResult,
  cards: CardRecord[],
  activeId: string,
  rememberedChildren: Record<string, string>,
  viewportHeight: number,
  tokens: WritingViewportTokens,
): StageLayoutResult {
  const positioned = layout.cards.map((card) => ({ ...card }));
  const byId = new Map(positioned.map((card) => [card.cardId, card]));
  const active = byId.get(activeId);
  if (!active) return layout;
  const top = -viewportHeight / 2 + tokens.verticalInset;
  const bottom = viewportHeight / 2 - tokens.verticalInset;
  const activeY = Math.max(0, top + active.height / 2);
  positioned.forEach((card) => { card.y += activeY; });
  const recordsById = new Map(cards.map((card) => [card.id, card]));
  const childrenByParent = new Map<string, CardRecord[]>();
  cards.forEach((card) => {
    if (card.parentId === null) return;
    const siblings = childrenByParent.get(card.parentId) ?? [];
    siblings.push(card);
    childrenByParent.set(card.parentId, siblings);
  });
  const childrenOf = (id: string) => (childrenByParent.get(id) ?? [])
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))
    .map((card) => byId.get(card.id)!).filter(Boolean);

  function childGroup(parentId: string) {
    const parent = byId.get(parentId)!;
    const children = childrenOf(parentId);
    if (!children.length) return children;
    const height = children.reduce((sum, card) => sum + card.height, 0)
      + (children.length - 1) * tokens.spacing;
    let cursor = 0;
    const offsets = children.map((card) => {
      const center = cursor + card.height / 2;
      cursor += card.height + tokens.spacing;
      return center;
    });
    const rememberedIndex = children.findIndex((card) => card.cardId === rememberedChildren[parentId]);
    const anchorHeight = rememberedIndex >= 0 ? children[rememberedIndex]!.height : height;
    const anchorCenter = Math.max(top + anchorHeight / 2,
      Math.min(parent.y, bottom - anchorHeight / 2));
    const groupTop = rememberedIndex >= 0
      ? anchorCenter - offsets[rememberedIndex]!
      : anchorCenter - height / 2;
    children.forEach((card, index) => { card.y = groupTop + offsets[index]!; });
    return children;
  }

  const children = childGroup(activeId);
  const groups = children.map((child) => childGroup(child.cardId)).filter((group) => group.length);
  // Keep the remembered return branch fixed, then displace neighboring groups
  // outward only as far as required to retain tree order and avoid overlap.
  const preferred = rememberedChildren[activeId] ?? children[0]?.cardId;
  const preferredGroup = groups.findIndex((group) => recordsById.get(group[0]!.cardId)?.parentId === preferred);
  const anchor = Math.max(0, preferredGroup);
  const shiftGroup = (index: number, delta: number) => groups[index]!.forEach((card) => { card.y += delta; });
  for (let index = anchor - 1; index >= 0; index -= 1) {
    const last = groups[index]![groups[index]!.length - 1]!;
    const next = groups[index + 1]![0]!;
    shiftGroup(index, Math.min(0, next.y - next.height / 2 - tokens.spacing - last.y - last.height / 2));
  }
  for (let index = anchor + 1; index < groups.length; index += 1) {
    const previous = groups[index - 1]![groups[index - 1]!.length - 1]!;
    const first = groups[index]![0]!;
    shiftGroup(index, Math.max(0, previous.y + previous.height / 2 + tokens.spacing - first.y + first.height / 2));
  }
  return {
    cards: positioned,
    emptyChildGap: layout.emptyChildGap ? { ...layout.emptyChildGap, y: activeY } : null,
  };
}
