import type { CardContentRecord, CardRecord } from "./types";

export const PASSAGE_ANCHOR_MARK = "passageAnchor";

interface ContentMark {
  type?: string;
  attrs?: Record<string, unknown>;
}
interface ContentNode {
  marks?: ContentMark[];
  content?: ContentNode[];
}

/** Preserve rich text verbatim unless an anchor needs changing. */
export function mapPassageAnchors(contentJson: string, mapId: (id: string) => string | null) {
  if (!contentJson.includes(PASSAGE_ANCHOR_MARK)) return contentJson;
  let document: ContentNode;
  try { document = JSON.parse(contentJson); } catch { return contentJson; }
  let changed = false;
  function visit(node: ContentNode) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.flatMap((mark) => {
        if (mark.type !== PASSAGE_ANCHOR_MARK) return [mark];
        const originalId = mark.attrs?.childCardId;
        const nextId = typeof originalId === "string" ? mapId(originalId) : null;
        if (nextId !== null && nextId === originalId) return [mark];
        changed = true;
        return nextId ? [{ ...mark, attrs: { ...mark.attrs, childCardId: nextId } }] : [];
      });
      if (node.marks.length === 0) delete node.marks;
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  }
  visit(document);
  return changed ? JSON.stringify(document) : contentJson;
}

/** Associations are valid only between a passage and its direct child. */
export function normalizePassageAnchors(cards: CardRecord[], contents: CardContentRecord[]) {
  const parents = new Map(cards.map((card) => [card.id, card.parentId]));
  return contents.map((content) => ({
    ...content,
    contentJson: mapPassageAnchors(content.contentJson, (id) =>
      parents.get(id) === content.cardId ? id : null),
  }));
}
