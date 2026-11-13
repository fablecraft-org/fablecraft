import { contentJsonForPlainText, cardContent, replaceCardContent } from "../src/domain/document/content";
import { normalizeDocumentSnapshot, serializeDocumentSnapshot } from "../src/domain/document/serialization";
import { createCardCopyPayload, createCardCutPayload, pasteCardClipboardPayload } from "../src/domain/document/clipboard";
import { createChildCard, deleteCardSubtree, moveCardWithinParent, outdentCard, mergeCardWithNextSibling } from "../src/domain/document/tree";
import { contentJsonToHtml, contentJsonToMarkdown } from "../src/domain/document/importExport";
import { useDocumentStore } from "../src/state/documentStore";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const anchoredText = (childCardId: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
  { type: "text", text: "A passage", marks: [{ type: "bold" }, { type: "passageAnchor", attrs: { childCardId } }] },
] }] });

describe("passage anchor lifecycle", () => {
  it("survives reordering, serialization and undo, but unlinks deleted or reparented children", () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), { cardId: "card-root", contentJson: anchoredText("card-a") });
    const reordered = moveCardWithinParent(snapshot, "card-a", 1);
    expect(cardContent(reordered, "card-root")).toBe(anchoredText("card-a"));
    expect(normalizeDocumentSnapshot(JSON.parse(serializeDocumentSnapshot(reordered)))).toEqual(reordered);
    const removed = deleteCardSubtree(reordered, "card-a");
    expect(cardContent(removed, "card-root")).not.toContain("passageAnchor");
    expect(cardContent(removed, "card-root")).toContain('"bold"');
    expect(cardContent(outdentCard(reordered, "card-a"), "card-root")).not.toContain("passageAnchor");
    useDocumentStore.getState().hydrateSnapshot(reordered);
    useDocumentStore.getState().applyNavigationChange(() => removed);
    useDocumentStore.getState().undoNavigation();
    expect(cardContent(useDocumentStore.getState().snapshot!, "card-root")).toBe(anchoredText("card-a"));
    useDocumentStore.getState().redoNavigation();
    expect(cardContent(useDocumentStore.getState().snapshot!, "card-root")).not.toContain("passageAnchor");
  });

  it("remaps all copied subtree references and strips prose-only paste references", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "a-child");
    snapshot = replaceCardContent(snapshot, { cardId: "card-root", contentJson: anchoredText("card-a") });
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: anchoredText("a-child") });
    const payload = createCardCutPayload(snapshot, "card-root");
    let id = 0;
    const pasted = pasteCardClipboardPayload(makeDocumentSnapshot(), "card-b", payload, () => `copy-${++id}`);
    const pastedA = pasted.cards.find((card) => card.parentId === "card-b" && card.orderIndex === 0)!;
    const pastedChild = pasted.cards.find((card) => card.parentId === pastedA.id)!;
    expect(cardContent(pasted, "card-b")).toBe(anchoredText(pastedA.id));
    expect(cardContent(pasted, pastedA.id)).toBe(anchoredText(pastedChild.id));
    const prose = pasteCardClipboardPayload(makeDocumentSnapshot(), "card-b", createCardCopyPayload(snapshot, "card-root"), () => "unused");
    expect(cardContent(prose, "card-b")).not.toContain("passageAnchor");
  });

  it("keeps child associations when their source content and children are merged together", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-b", "b-child");
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: contentJsonForPlainText("First") });
    snapshot = replaceCardContent(snapshot, { cardId: "card-b", contentJson: anchoredText("b-child") });
    const merged = mergeCardWithNextSibling(snapshot, "card-a");
    expect(merged.cards.find((card) => card.id === "b-child")?.parentId).toBe("card-a");
    expect(cardContent(merged, "card-a")).toContain("passageAnchor");
    expect(contentJsonToMarkdown(cardContent(merged, "card-a"))).not.toContain("passageAnchor");
    expect(contentJsonToHtml(cardContent(merged, "card-a"))).toContain("A passage");
    expect(contentJsonToHtml(cardContent(merged, "card-a"))).not.toContain("childCardId");
  });
});
