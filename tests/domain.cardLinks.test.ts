import { describe, expect, it } from "vitest";
import { resolveCardLabel } from "../src/domain/document/cardLinks";
import { cardContent, contentText, isContentEffectivelyEmpty, replaceCardContent } from "../src/domain/document/content";
import { normalizeDocumentSnapshot, serializeDocumentSnapshot } from "../src/domain/document/serialization";
import { createCardCopyPayload, createCardCutPayload, pasteCardClipboardPayload } from "../src/domain/document/clipboard";
import { deleteCardSubtree, moveCardWithinParent } from "../src/domain/document/tree";
import { contentJsonToHtml, contentJsonToMarkdown } from "../src/domain/document/importExport";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const link = (id: string, label: string) => JSON.stringify({ type: "doc", content: [
  { type: "paragraph", content: [{ type: "cardLink", attrs: { targetCardId: id, label } }] },
] });

describe("card references", () => {
  it("accepts padded and unpadded labels", () => {
    for (const label of ["#B8", "#B08"]) expect(resolveCardLabel({ fixed: "B08" }, label)).toBe("fixed");
    expect(resolveCardLabel({ fixed: "B08" }, "#B9")).toBeNull();
  });

  it("keeps identity through reorder, deletion, restoration and snapshot round trips", () => {
    let snapshot = replaceCardContent(makeDocumentSnapshot(), { cardId: "card-root", contentJson: link("card-a", "B01") });
    snapshot = moveCardWithinParent(snapshot, "card-a", 1);
    expect(cardContent(snapshot, "card-root")).toContain('"targetCardId":"card-a"');
    expect(contentText(cardContent(snapshot, "card-root"))).toBe("B02");
    const removed = deleteCardSubtree(snapshot, "card-a");
    expect(cardContent(removed, "card-root")).toContain('"targetCardId":"card-a"');
    expect(normalizeDocumentSnapshot(JSON.parse(serializeDocumentSnapshot(snapshot)))).toEqual(snapshot);
    expect(isContentEffectivelyEmpty(cardContent(snapshot, "card-root"))).toBe(false);
    expect(contentJsonToMarkdown(cardContent(snapshot, "card-root"))).toBe("B02");
    expect(contentJsonToHtml(cardContent(snapshot, "card-root"))).toBe("<p>B02</p>");
  });

  it("remaps internal subtree references and converts external references to text across documents", () => {
    let source = replaceCardContent(makeDocumentSnapshot(), { cardId: "card-root", contentJson: link("card-a", "B01") });
    source = replaceCardContent(source, { cardId: "card-a", contentJson: link("card-root", "A01") });
    const payload = createCardCutPayload(source, "card-root");
    const target = makeDocumentSnapshot();
    target.summary.documentId = "doc-2";
    let index = 0;
    const pasted = pasteCardClipboardPayload(target, "card-a", payload, () => `fresh-${++index}`);
    expect(cardContent(pasted, "card-a")).toContain('"targetCardId":"fresh-1"');
    expect(cardContent(pasted, "fresh-1")).toContain('"targetCardId":"card-a"');
    const external = pasteCardClipboardPayload(target, "card-b", createCardCopyPayload(source, "card-a"), () => "unused");
    expect(cardContent(external, "card-b")).not.toContain("cardLink");
    expect(contentText(cardContent(external, "card-b"))).toBe("A01");
  });
});
