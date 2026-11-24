import type { Node as ProseNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { hasPassageText, mapManuscriptPassages, manuscriptUuid } from "./manuscript";
import type { ManuscriptPassage } from "./types";

export const MANUSCRIPT_CUT_MIME = "application/x-fablecraft-manuscript-cut";

interface CutRange {
  passage: ManuscriptPassage;
  first: number;
  last: number;
  whole: boolean;
}

function textPositions(doc: ProseNode, from: number, to: number) {
  const positions: { pos: number; value: string }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "hardBreak") {
      positions.push({ pos, value: "\n" });
      return;
    }
    if (!node.isText) return;
    for (let at = Math.max(from, pos); at < Math.min(to, pos + node.nodeSize); at++) {
      positions.push({ pos: at, value: node.text![at - pos]! });
    }
  });
  return positions;
}

export function cutPassageRanges(doc: ProseNode, from: number, to: number, passages: ManuscriptPassage[]) {
  const text = textPositions(doc, from, to);
  const ranges: CutRange[] = [];
  if (!text.length) return { text, ranges };

  function indexAt(pos: number) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (text[mid]!.pos < pos) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  for (const passage of passages) {
    const start = Math.max(from, passage.from);
    const end = Math.min(to, passage.to);
    if (!hasPassageText(doc, start, end)) continue;
    ranges.push({
      passage,
      first: indexAt(start),
      last: indexAt(end) - 1,
      whole: from <= passage.from && passage.to <= to,
    });
  }
  return { text, ranges };
}

export interface ManuscriptCut {
  slice: Slice;
  token: string;
  documentKey: string;
  manuscriptId: string;
  anchor: object;
  fragment: ReturnType<typeof cutPassageRanges>;
}

export function pasteCutPassages(tr: Transaction, cut: ManuscriptCut, current: ManuscriptPassage[], targets: Set<string>) {
  if (!tr.docChanged) return null;
  // Match the inserted UTF-16 units after ProseMirror fits the slice to
  // its destination. Wrapper positions can differ from the cut source.
  const intervals: [number, number][] = [];
  tr.mapping.maps[0]?.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
    if (newFrom < newTo) intervals.push([newFrom, newTo]);
  });
  if (!intervals.length) return null;
  const tail = tr.mapping.slice(1);
  const inserted = intervals.flatMap(([from, to]) =>
    textPositions(tr.doc, tail.map(from, 1), tail.map(to, -1)));
  if (inserted.length !== cut.fragment.text.length ||
    !inserted.every(({ value }, index) => value === cut.fragment.text[index]!.value)) return null;

  const passages = mapManuscriptPassages(current, tr);
  for (const { first, last, passage, whole } of cut.fragment.ranges) {
    const targetCardIds = passage.targetCardIds.filter((id) => targets.has(id));
    if (!targetCardIds.length) continue;
    const from = inserted[first]!.pos;
    const to = inserted[last]!.pos + 1;
    const sameId = passages.some(({ id }) => id === passage.id);
    passages.push({ id: whole && !sameId ? passage.id : manuscriptUuid(), from, to, targetCardIds });
  }
  return passages;
}
