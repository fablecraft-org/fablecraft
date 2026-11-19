import { describe, expect, it } from "vitest";
import { referenceTree, referencedCardIds, appearanceId } from "../src/domain/document/references";
import { cardContent, replaceCardContent } from "../src/domain/document/content";
import { createChildCard, deleteCardSubtree } from "../src/domain/document/tree";
import { buildDescendantCountMap } from "../src/domain/document/descendantCounts";
import { exportCurrentLevel } from "../src/domain/document/importExport";
import { stageLayout } from "../src/domain/document/spatial";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const content = (...ids: string[]) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: ids.map((id) =>
  ({ type: "cardLink", attrs: { targetCardId: id, label: "B02" } })) }] });
const root = { cardId: "card-root", alias: false };
const a = { cardId: "card-a", alias: false };
const aliasB = { cardId: "card-b", alias: true };

describe("reference appearance tree", () => {
  it("deduplicates by first mention and places aliases above owned children with owned-first Right routing", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "owned");
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: content("card-b", "card-b", "card-root") });
    const tree = referenceTree(snapshot, "card-a");
    const group = tree.cards.filter((card) => card.parentId === "card-a");
    expect(group).toHaveLength(2);
    expect(tree.appearances.get(group[0]!.id)?.isAlias).toBe(true);
    expect(group[1]?.id).toBe("owned");
    expect(tree.preferredChildren["card-a"]).toBe("owned");
    const layout = stageLayout(tree.cards, "card-a", { cardHeight: 84, cardWidth: 400, spacing: 24, rememberedChildIds: tree.preferredChildren });
    expect(layout.cards.find((card) => card.cardId === "owned")?.y).toBe(0);
    expect(layout.cards.find((card) => card.cardId === group[0]?.id)!.y).toBeLessThan(0);
    expect(referencedCardIds(cardContent(snapshot, "card-a"))).toEqual(["card-b", "card-root"]);
  });

  it("excludes real ancestors including grandparents, but distinguishes an alias from an owned appearance of the same target", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "owned");
    snapshot = replaceCardContent(snapshot, { cardId: "owned", contentJson: content("card-a", "card-root") });
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: content("owned") });
    const tree = referenceTree(snapshot, "card-a");
    expect(tree.cards.filter((card) => card.parentId === "owned")).toHaveLength(0);
    const children = tree.cards.filter((card) => card.parentId === "card-a");
    expect(children.map((card) => tree.appearances.get(card.id)?.cardId)).toEqual(["owned", "owned"]);
    expect(children[0]?.id).not.toBe(children[1]?.id);
  });

  it("expands reference children along the selected path and falls back to the alias without owned children", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-b", "b-child");
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: content("card-b") });
    const path = [root, a, aliasB];
    const tree = referenceTree(snapshot, "card-b", path);
    expect(tree.activeId).toBe(appearanceId(path));
    const child = tree.cards.find((card) => card.parentId === tree.activeId)!;
    expect(tree.appearances.get(child.id)?.path).toEqual([...path, { cardId: "b-child", alias: false }]);
    expect(tree.preferredChildren["card-a"]).toBe(appearanceId(path));
    expect(tree.cards.find((card) => card.id === tree.activeId)?.parentId).toBe("card-a");
  });

  it("permits two appearances of a fixed id on a path and omits a third, including self references", () => {
    let snapshot = replaceCardContent(makeDocumentSnapshot(), { cardId: "card-a", contentJson: content("card-b", "card-a") });
    snapshot = replaceCardContent(snapshot, { cardId: "card-b", contentJson: content("card-a") });
    const path = [root, a, aliasB, { cardId: "card-a", alias: true }, aliasB];
    const tree = referenceTree(snapshot, "card-b", path);
    expect(tree.activeId).toBe(appearanceId(path));
    expect(tree.cards.filter((card) => card.parentId === tree.activeId)).toHaveLength(0);
    for (const appearance of tree.appearances.values()) {
      for (const step of appearance.path) expect(appearance.path.filter((other) => other.cardId === step.cardId).length).toBeLessThanOrEqual(2);
    }
    const self = referenceTree(snapshot, "card-a", [root, a, { cardId: "card-a", alias: true }]);
    expect(self.appearances.get(self.activeId!)?.isReference).toBe(true);
    expect(self.cards.filter((card) => card.parentId === self.activeId).some((card) => self.appearances.get(card.id)?.cardId === "card-a")).toBe(false);
  });

  it("keeps deleted targets as terminal appearances and reconciles removed links to the surviving source", () => {
    let snapshot = replaceCardContent(makeDocumentSnapshot(), { cardId: "card-a", contentJson: content("card-b") });
    const path = [root, a, aliasB];
    snapshot = deleteCardSubtree(snapshot, "card-b");
    const missing = referenceTree(snapshot, "card-b", path);
    expect(missing.appearances.get(missing.activeId!)?.missing).toBe(true);
    expect(missing.cards.filter((card) => card.parentId === missing.activeId)).toHaveLength(0);
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: content() });
    expect(referenceTree(snapshot, "card-b", path).activeId).toBe("card-a");
  });

  it("does not change ownership, counts or exports, and bounds a densely linked graph", () => {
    let snapshot = makeDocumentSnapshot();
    snapshot = replaceCardContent(snapshot, { cardId: "card-a", contentJson: content("card-b") });
    const before = JSON.stringify(snapshot);
    const tree = referenceTree(snapshot, "card-a");
    expect(tree.cards.length).toBeGreaterThan(snapshot.cards.length);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(buildDescendantCountMap(snapshot.cards)["card-a"]).toBe(0);
    expect(exportCurrentLevel(snapshot, "card-a", "markdown").cardCount).toBe(1);
    const many = makeDocumentSnapshot();
    for (let index = 0; index < 40; index += 1) many.cards.push({ id: `dense-${index}`, documentId: "doc-1", parentId: null, orderIndex: index + 1, type: "card" });
    many.contents = many.cards.map((card) => ({ cardId: card.id, contentJson: content(...many.cards.map((target) => target.id)) }));
    expect(referenceTree(many, "dense-0").cards.length).toBeLessThanOrEqual(many.cards.length * (many.cards.length + 1));
  });
});
