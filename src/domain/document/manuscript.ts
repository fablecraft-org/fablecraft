import type { Node as ProseNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { CardRecord, Manuscript, ManuscriptPassage } from "./types";

export function manuscriptUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function pruneManuscriptTargets(manuscript: Manuscript | null | undefined, cards: CardRecord[]) {
  if (!manuscript?.passages.length) return manuscript;
  const ids = new Set(cards.map((card) => card.id));
  if (manuscript.passages.every((passage) => passage.targetCardIds.every((id) => ids.has(id)))) return manuscript;
  return {
    ...manuscript,
    passages: manuscript.passages.flatMap((passage) => {
      const targetCardIds = passage.targetCardIds.filter((id) => ids.has(id));
      return targetCardIds.length ? [{ ...passage, targetCardIds }] : [];
    }),
  };
}

export function hasPassageText(doc: ProseNode, from: number, to: number) {
  return 0 <= from && from < to && to <= doc.content.size && Boolean(doc.textBetween(from, to, " ").trim());
}

export function selectedPassageRange(doc: ProseNode, from: number, to: number) {
  if (!hasPassageText(doc, from, to)) return null;
  let start: number | undefined;
  let end = to;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText && node.type.name !== "hardBreak") return;
    start ??= Math.max(from, pos);
    end = Math.min(to, pos + node.nodeSize);
  });
  return start === undefined ? null : { from: start, to: end };
}

export function mapManuscriptPassages(passages: ManuscriptPassage[], tr: Transaction) {
  if (!tr.docChanged || !passages.length) return passages;
  return passages.flatMap((passage) => {
    let { from, to } = passage;
    let textMayHaveChanged = false;
    for (const step of tr.mapping.maps) {
      let replacement: { from: number; to: number } | undefined;
      step.forEach((oldFrom, oldTo, newFrom, newTo) => {
        if (oldFrom < oldTo && oldFrom < to && oldTo > from) textMayHaveChanged = true;
        if (oldFrom < oldTo && oldFrom <= from && to <= oldTo && newFrom < newTo) {
          replacement = { from: newFrom, to: newTo };
        }
      });
      from = replacement?.from ?? step.map(from, 1);
      to = replacement?.to ?? step.map(to, -1);
      if (from >= to) return [];
    }
    if (textMayHaveChanged && !hasPassageText(tr.doc, from, to)) return [];
    return [from === passage.from && to === passage.to ? passage : { ...passage, from, to }];
  });
}

export interface PassageEntry extends ManuscriptPassage {
  excerpt: string;
  lines: string;
}

function manuscriptLines(doc: ProseNode) {
  const starts: number[] = [];
  const textblocks: { from: number; to: number; node: ProseNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      textblocks.push({ from: pos + 1, to: pos + node.nodeSize - 1, node });
      starts.push(pos + 1);
    }
    if (node.type.name === "horizontalRule" || node.type.name === "hardBreak") starts.push(pos + 1);
    if (node.isText && node.text?.includes("\n")) {
      for (let i = 0; i < node.text.length; i++) if (node.text[i] === "\n") starts.push(pos + i + 1);
    }
  });
  return { starts, textblocks };
}

function precedingIndex<T>(items: T[], pos: number, offset: (item: T) => number) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offset(items[mid]!) <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function passageIndex(doc: ProseNode, passages: ManuscriptPassage[]) {
  const { starts, textblocks } = manuscriptLines(doc);
  const offsetOfLine = (offset: number) => offset;
  const offsetOfBlock = (block: (typeof textblocks)[number]) => block.from;
  return [...passages].sort((a, b) => a.from - b.from || a.to - b.to).map((passage): PassageEntry => {
    const { from, to } = passage;
    const fromLine = Math.max(1, precedingIndex(starts, from, offsetOfLine) + 1);
    const toLine = Math.max(1, precedingIndex(starts, to - 1, offsetOfLine) + 1);
    // Most excerpts are entirely in one textblock. Look up the block
    // without traversing preceding paragraphs for every backlink.
    const stop = Math.min(to, from + 240);
    const block = textblocks[precedingIndex(textblocks, from, offsetOfBlock)];
    const raw = (block && stop <= block.to
      ? block.node.textBetween(from - block.from, stop - block.from, " ", " ")
      : doc.textBetween(from, stop, " ", " ")).trim().replace(/\s+/gu, " ");
    const characters = Array.from(raw);
    const excerpt = characters.length > 64 ? characters.slice(0, 63).join("") + "…" : raw;
    return { ...passage, excerpt, lines: fromLine === toLine ? `L${fromLine}` : `L${fromLine}–${toLine}` };
  });
}

function replaceLinkedRange(doc: ProseNode, passages: ManuscriptPassage[], next: ManuscriptPassage) {
  const remaining = passages.flatMap((passage) => {
    if (passage.to <= next.from || passage.from >= next.to) return [passage];
    const from = Math.max(passage.from, next.to);
    const to = Math.min(passage.to, next.from);
    const left = hasPassageText(doc, passage.from, to) ? { ...passage, to } : null;
    const right = hasPassageText(doc, from, passage.to)
      ? { ...passage, from, id: left ? manuscriptUuid() : passage.id } : null;
    return [left, right].filter((part): part is ManuscriptPassage => part !== null);
  });
  return [...remaining, next];
}

export function resolveManuscriptOverlaps(doc: ProseNode, passages: ManuscriptPassage[]) {
  if (passages.length < 2) return passages;
  const sorted = [...passages].sort((a, b) => a.from - b.from || a.to - b.to);
  if (sorted.every((passage, index) => index === 0 || sorted[index - 1]!.to <= passage.from)) return passages;
  return passages.reduce<ManuscriptPassage[]>((result, passage) => replaceLinkedRange(doc, result, passage), []);
}

export function addManuscriptTarget(
  prose: Manuscript, doc: ProseNode, from: number, to: number, cardId: string,
): Manuscript {
  const existing = prose.passages.find((passage) => passage.from === from && passage.to === to);
  if (existing?.targetCardIds[0] === cardId) return prose;
  return {
    ...prose,
    passages: replaceLinkedRange(doc, prose.passages, {
      from, to, id: existing?.id ?? manuscriptUuid(), targetCardIds: [cardId],
    }),
  };
}
