import { buildCardNumberMap } from "./cardNumbers";
import type { CardRecord, CardContentRecord } from "./types";

export const CARD_LINK_NODE = "cardLink";

export function resolveCardLabel(labels: Record<string, string>, label: string) {
  const match = /^#?([A-Z])(\d+)$/i.exec(label);
  if (!match) return null;
  const canonical = `${match[1]!.toUpperCase()}${String(Number(match[2])).padStart(2, "0")}`;
  return Object.keys(labels).find((id) => labels[id] === canonical) ?? null;
}

interface LinkNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: LinkNode[];
}

/** Null mappings become ordinary text, so cross-document paste cannot misdirect links. */
export function mapCardLinks(contentJson: string, mapId: (id: string) => string | null) {
  if (!contentJson.includes(`"${CARD_LINK_NODE}"`)) return contentJson;
  let document: LinkNode;
  try { document = JSON.parse(contentJson); } catch { return contentJson; }
  function visit(node: LinkNode): LinkNode {
    if (node.type === CARD_LINK_NODE) {
      const id = typeof node.attrs?.targetCardId === "string" ? mapId(node.attrs.targetCardId) : null;
      return id
        ? { ...node, attrs: { ...node.attrs, targetCardId: id } }
        : { type: "text", text: String(node.attrs?.label ?? "Missing card") };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  }
  return JSON.stringify(visit(document));
}

/** Keep the persisted text fallback current without changing the reference identity. */
export function normalizeCardLinkLabels(cards: CardRecord[], contents: CardContentRecord[]) {
  if (!contents.some((content) => content.contentJson.includes(`"${CARD_LINK_NODE}"`))) return contents;
  const labels = buildCardNumberMap({ cards });
  return contents.map((content) => {
    if (!content.contentJson.includes(`"${CARD_LINK_NODE}"`)) return content;
    let node: LinkNode;
    try { node = JSON.parse(content.contentJson); } catch { return content; }
    let changed = false;
    function visit(node: LinkNode) {
      if (node.type === CARD_LINK_NODE && typeof node.attrs?.targetCardId === "string") {
        const label = labels[node.attrs.targetCardId];
        if (label && label !== node.attrs.label) {
          node.attrs.label = label;
          changed = true;
        }
      }
      node.content?.forEach(visit);
    }
    visit(node);
    return changed ? { ...content, contentJson: JSON.stringify(node) } : content;
  });
}
