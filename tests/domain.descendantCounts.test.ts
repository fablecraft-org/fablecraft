import { buildDescendantCountMap } from "../src/domain/document/descendantCounts";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

describe("descendant counts", () => {
  it("counts every depth, excludes the card itself, and keeps root trees separate", () => {
    const { cards } = makeDocumentSnapshot();
    cards.push(
      { ...cards[1]!, id: "a-child", parentId: "card-a" },
      { ...cards[1]!, id: "grandchild", parentId: "a-child" },
      { ...cards[0]!, id: "other-root", orderIndex: 1 },
    );
    expect(buildDescendantCountMap([...cards].reverse())).toEqual({
      "card-root": 4, "card-a": 2, "card-b": 0,
      "a-child": 1, "grandchild": 0, "other-root": 0,
    });
    cards.find((card) => card.id === "a-child")!.parentId = "card-b";
    expect(buildDescendantCountMap(cards)).toMatchObject({
      "card-root": 4, "card-a": 0, "card-b": 2,
    });
    expect(buildDescendantCountMap([])).toEqual({});
  });
});
