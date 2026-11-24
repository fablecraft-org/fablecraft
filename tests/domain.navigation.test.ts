import {
  firstChildCardId,
  navigationBoundaryCardId,
  preferredChildCardId,
  nextSiblingCardId,
  nextVisibleCardId,
  parentCardId,
  previousSiblingCardId,
  previousVisibleCardId,
  visibleCardIds,
} from "../src/domain/document/navigation";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

describe("document navigation", () => {
  it("jumps to same-parent boundaries and the current branch root across uneven trees", () => {
    const { cards } = makeDocumentSnapshot();
    cards.push(
      { ...cards[1]!, id: "last", orderIndex: 3 },
      { ...cards[0]!, id: "other-root", orderIndex: 1 },
      { ...cards[1]!, id: "cousin", parentId: "other-root", orderIndex: 0 },
      { ...cards[1]!, id: "deep", parentId: "card-b", orderIndex: 0 },
      { ...cards[1]!, id: "deeper", parentId: "deep", orderIndex: 0 },
    );
    expect(navigationBoundaryCardId(cards, "card-b", "up")).toBe("card-a");
    expect(navigationBoundaryCardId(cards, "card-b", "down")).toBe("last");
    expect(navigationBoundaryCardId(cards, "cousin", "up")).toBe("cousin");
    expect(navigationBoundaryCardId(cards, "cousin", "down")).toBe("cousin");
    expect(navigationBoundaryCardId(cards, "deeper", "left")).toBe("card-root");
    expect(navigationBoundaryCardId(cards, "cousin", "left")).toBe("other-root");
    expect(navigationBoundaryCardId(cards, "other-root", "left")).toBe("other-root");
    expect(navigationBoundaryCardId(cards, "other-root", "up")).toBe("card-root");
    expect(navigationBoundaryCardId(cards, "card-root", "down")).toBe("other-root");
    expect(navigationBoundaryCardId(cards, "missing", "left")).toBeNull();
  });
  it("uses remembered direct children and falls back for deleted or reparented targets", () => {
    const { cards } = makeDocumentSnapshot();
    expect(preferredChildCardId(cards, "card-root", { "card-root": "card-b" })).toBe("card-b");
    for (const target of ["missing", "card-root"]) {
      expect(preferredChildCardId(cards, "card-root", { "card-root": target })).toBe("card-a");
    }
    expect(preferredChildCardId(cards, "card-a", {})).toBeNull();
  });

  it("walks visible cards in preorder for unbalanced trees", () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push(
      {
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      },
      {
        documentId: "doc-1",
        id: "card-a-2",
        orderIndex: 1,
        parentId: "card-a",
        type: "card",
      },
    );

    expect(visibleCardIds(snapshot.cards)).toEqual([
      "card-root",
      "card-a",
      "card-a-1",
      "card-a-2",
      "card-b",
    ]);
  });

  it("resolves parent and first-child movement", () => {
    const snapshot = makeDocumentSnapshot();

    expect(parentCardId(snapshot.cards, "card-a")).toBe("card-root");
    expect(firstChildCardId(snapshot.cards, "card-root")).toBe("card-a");
  });

  it("moves up and down across uneven branches", () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push({
      documentId: "doc-1",
      id: "card-a-1",
      orderIndex: 0,
      parentId: "card-a",
      type: "card",
    });

    expect(nextVisibleCardId(snapshot.cards, "card-a")).toBe("card-a-1");
    expect(nextVisibleCardId(snapshot.cards, "card-a-1")).toBe("card-b");
    expect(previousVisibleCardId(snapshot.cards, "card-b")).toBe("card-a-1");
  });

  it("moves up and down through siblings without dropping into children", () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push(
      {
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      },
      {
        documentId: "doc-1",
        id: "card-a-2",
        orderIndex: 1,
        parentId: "card-a",
        type: "card",
      },
    );

    expect(nextSiblingCardId(snapshot.cards, "card-a")).toBe("card-b");
    expect(previousSiblingCardId(snapshot.cards, "card-b")).toBe("card-a");
    expect(nextSiblingCardId(snapshot.cards, "card-a-1")).toBe("card-a-2");
    expect(previousSiblingCardId(snapshot.cards, "card-a-1")).toBeNull();
  });
});
