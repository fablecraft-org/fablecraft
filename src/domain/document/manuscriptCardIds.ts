import type { Node as ProseNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { resolveCardLabel } from "./cardLinks";

export function manuscriptParagraphAt(doc: ProseNode, pos: number) {
  if (pos < 0 || pos > doc.content.size) return null;
  const resolved = doc.resolve(pos);
  if (resolved.parent.type.name !== "paragraph") return null;
  return { from: resolved.start(), to: resolved.end(), node: resolved.parent };
}

const tokenAtInput = /(?:^|[\s([{])(#([A-Za-z]\d+))([\s.,!?;:)\]}]?)$/u;
const continuesToken = /^[\p{L}\p{N}_-]/u;
const finishesToken = /[\d\s.,!?;:)\]}]$/u;

export function typedManuscriptCardId(tr: Transaction, labels: Record<string, string>) {
  if (tr.getMeta("uiEvent") || tr.steps.length !== 1) return null;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return null;
  const inserted = step.slice.content.firstChild;
  if (step.slice.content.childCount !== 1 || !inserted?.isText || !finishesToken.test(inserted.text ?? "")) return null;
  const paragraph = manuscriptParagraphAt(tr.doc, step.from);
  if (!paragraph) return null;

  const end = step.from + step.slice.size;
  if (end > paragraph.to) return null;
  const offset = end - paragraph.from;
  const text = paragraph.node.textBetween(0, offset, "", "\n");
  const match = tokenAtInput.exec(text);
  if (!match) return null;
  const delimiter = match[3]!;
  const tokenEnd = end - delimiter.length;
  const tokenStart = tokenEnd - match[1]!.length;
  if (tokenEnd < step.from || continuesToken.test(paragraph.node.textBetween(offset, offset + Math.min(1, paragraph.to - end)))) return null;

  const code = tr.doc.type.schema.marks.code;
  if (code && tr.doc.rangeHasMark(tokenStart, tokenEnd, code)) return null;

  const id = resolveCardLabel(labels, match[2]!);
  if (!id) return null;
  const spelling = match[2]!.toUpperCase();
  // Wait for a delimiter if an ID could still grow into a different card ID.
  if (!delimiter && (labels[id] !== spelling ||
    Object.values(labels).some((label) => label !== spelling && label.startsWith(spelling)))) return null;
  return {
    cardId: id,
    paragraphStart: paragraph.from,
    from: tokenStart,
    to: tokenStart === paragraph.from && delimiter === " " ? end : tokenEnd,
  };
}

export function mapManuscriptParagraphStart(tr: Transaction, start: number) {
  const opening = tr.mapping.mapResult(start - 1, 1);
  if (opening.deletedAfter) return null;
  return manuscriptParagraphAt(tr.doc, opening.pos + 1)?.from ?? null;
}
