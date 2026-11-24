import { arrangeWritingStage, writingViewport } from "../src/domain/document/writingLayout";
import { stageLayout } from "../src/domain/document/spatial";
import { writingLayoutTokens as tokens } from "../src/styles/tokens";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

describe("responsive writing layout", () => {
  it.each([[408, 1], [791, 1], [792, 2], [1175, 2], [1176, 3], [1559, 3], [1560, 4], [2560, 4]])(
    "uses %i workspace pixels for %i columns with constant margins and gaps", (width, columns) => {
      const result = writingViewport(width, tokens);
      expect(result.columns).toBe(columns);
      expect(result.cardWidth).toBeGreaterThanOrEqual(360);
      expect(result.cardWidth * columns + (columns - 1) * tokens.spacing + tokens.margin * 2).toBeCloseTo(width);
      expect(result.activeX).toBeCloseTo(columns % 2 ? 0 : -(result.cardWidth + tokens.spacing) / 2);
    },
  );

  it("keeps a browser embed narrower than the native window usable", () => {
    expect(writingViewport(300, tokens)).toMatchObject({ columns: 1, cardWidth: 252, activeX: 0 });
  });

  it("can use the left slot for the parent in a two-column viewport", () => {
    const options = { showParentInTwoColumns: true };
    expect(writingViewport(792, tokens, options)).toMatchObject({
      columns: 2, cardWidth: 360, activeX: 192, minimumDepth: -1, maximumDepth: 0,
    });
    for (const width of [791, 1176, 1560]) {
      expect(writingViewport(width, tokens, options)).toEqual(writingViewport(width, tokens));
    }
  });

  it.each([[408, 360], [800, 752], [1440, 880], [2560, 880]])(
    "centers a document-width focused card in a %i pixel viewport", (width, cardWidth) => {
      expect(writingViewport(width, tokens, { focused: true, showParentInTwoColumns: true })).toMatchObject({ columns: 1, cardWidth,
        activeX: 0, minimumDepth: 0, maximumDepth: 0 });
    },
  );

  function layout(heights: Record<string, number>, memory: Record<string, string> = {}, height = 720) {
    const snapshot = makeDocumentSnapshot();
    const base = stageLayout(snapshot.cards, "card-root", {
      cardWidth: 400, cardHeight: 84, spacing: tokens.spacing, cardHeights: heights, rememberedChildIds: memory,
    });
    const arranged = arrangeWritingStage(base, snapshot.cards, "card-root", memory, height, tokens);
    return new Map(arranged.cards.map((card) => [card.cardId, card]));
  }

  it("centers unequal children using the group's total footprint", () => {
    const cards = layout({ "card-a": 100, "card-b": 200 });
    expect(cards.get("card-a")!.y - 50).toBe(-162);
    expect(cards.get("card-b")!.y + 100).toBe(162);
    expect(cards.get("card-b")!.y - 100 - (cards.get("card-a")!.y + 50)).toBe(24);
  });

  it("starts overflowing unremembered children at the top inset", () => {
    const cards = layout({ "card-a": 400, "card-b": 500 });
    expect(cards.get("card-a")!.y - 200).toBe(-312);
    expect(cards.get("card-b")!.y + 250).toBeGreaterThan(360);
  });

  it("lets earlier siblings overflow above a remembered child", () => {
    const cards = layout({ "card-a": 700, "card-b": 100 }, { "card-root": "card-b" });
    expect(cards.get("card-b")!.y).toBe(0);
    expect(cards.get("card-a")!.y - 350).toBeLessThan(-360);
  });

  it("keeps the start of a tall remembered child visible", () => {
    const cards = layout({ "card-b": 1200 }, { "card-root": "card-b" });
    expect(cards.get("card-b")!.y - 600).toBe(-312);
  });

  it("keeps a long active card and its remembered child starts visible", () => {
    const cards = layout({ "card-root": 3000, "card-b": 100 }, { "card-root": "card-b" });
    expect(cards.get("card-root")!.y - 1500).toBe(-312);
    expect(cards.get("card-b")!.y + 50).toBeLessThanOrEqual(312);
  });

  it("falls back to group centering for deleted or reparented memory", () => {
    expect(layout({}, { "card-root": "missing" })).toEqual(layout({}));
  });

  it("centers one child on its parent and packs grandchild groups around the remembered branch", () => {
    const snapshot = makeDocumentSnapshot();
    snapshot.cards.push(
      { documentId: "doc-1", id: "a1", parentId: "card-a", orderIndex: 0, type: "card" },
      { documentId: "doc-1", id: "b1", parentId: "card-b", orderIndex: 0, type: "card" },
      { documentId: "doc-1", id: "b2", parentId: "card-b", orderIndex: 1, type: "card" },
    );
    const memory = { "card-root": "card-b", "card-b": "b2" };
    const options = { cardWidth: 400, cardHeight: 84, spacing: 24, cardHeights: { a1: 600 }, rememberedChildIds: memory };
    const base = stageLayout(snapshot.cards, "card-root", options);
    const original = JSON.stringify(base);
    const result = arrangeWritingStage(base, snapshot.cards, "card-root", memory, 720, tokens);
    const byId = new Map(result.cards.map((card) => [card.cardId, card]));
    expect(byId.get("b2")!.y).toBe(byId.get("card-b")!.y);
    const a1 = byId.get("a1")!;
    const b1 = byId.get("b1")!;
    expect(b1.y - b1.height / 2 - a1.y - a1.height / 2).toBeGreaterThanOrEqual(24);
    // The input navigation layout is never mutated by viewport refinement.
    expect(JSON.stringify(base)).toBe(original);
    snapshot.cards = snapshot.cards.filter((card) => card.id !== "card-b");
    const one = arrangeWritingStage(stageLayout(snapshot.cards, "card-root", options), snapshot.cards, "card-root", {}, 720, tokens);
    expect(one.cards.find((card) => card.cardId === "card-a")!.y).toBe(0);
  });
});
