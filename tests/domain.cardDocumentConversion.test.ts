import { describe, expect, it } from "vitest";
import {
  createDocumentFromCardSubtree,
  defaultConvertedDocumentName,
  removeConvertedCardFromSource,
} from "../src/domain/document/cardDocumentConversion";
import { contentJsonForPlainText } from "../src/domain/document/content";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { createChildCard } from "../src/domain/document/tree";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const targetSummary = {
  documentId: "doc-2",
  name: "Extracted",
  openedAtMs: 2,
  path: "/tmp/extracted.fable",
};

describe("card to document conversion", () => {
  it("creates a new document from the selected card and its children", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "card-a-1");
    snapshot = createChildCard(snapshot, "card-a", "card-a-2");
    snapshot = {
      ...snapshot,
      contents: snapshot.contents.map((content) => {
        if (content.cardId === "card-a") {
          return { ...content, contentJson: contentJsonForPlainText("Chapter One") };
        }

        if (content.cardId === "card-a-1") {
          return { ...content, contentJson: contentJsonForPlainText("First child") };
        }

        if (content.cardId === "card-a-2") {
          return { ...content, contentJson: contentJsonForPlainText("Second child") };
        }

        return content;
      }),
    };

    const converted = createDocumentFromCardSubtree(
      snapshot,
      "card-a",
      targetSummary,
    );

    expect(converted.summary).toEqual(targetSummary);
    expect(converted.revisions).toEqual([]);
    expect(converted.cards.map((card) => ({
      documentId: card.documentId,
      id: card.id,
      orderIndex: card.orderIndex,
      parentId: card.parentId,
    }))).toEqual([
      { documentId: "doc-2", id: "card-a", orderIndex: 0, parentId: null },
      { documentId: "doc-2", id: "card-a-1", orderIndex: 0, parentId: "card-a" },
      { documentId: "doc-2", id: "card-a-2", orderIndex: 1, parentId: "card-a" },
    ]);
    expect(converted.contents.map((content) => content.cardId)).toEqual([
      "card-a",
      "card-a-1",
      "card-a-2",
    ]);
  });

  it("removes the converted subtree from the source document", () => {
    const snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "card-a-1");

    const source = removeConvertedCardFromSource(snapshot, "card-a");
    const rootChildren = source.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(source.cards.some((card) => card.id === "card-a")).toBe(false);
    expect(source.cards.some((card) => card.id === "card-a-1")).toBe(false);
    expect(rootChildren.map((card) => [card.id, card.orderIndex])).toEqual([
      ["card-b", 0],
    ]);
  });

  it("keeps the source document valid when converting the final root", () => {
    const onlyRootSnapshot = {
      ...createChildCard(
        {
          ...makeDocumentSnapshot(),
          cards: makeDocumentSnapshot().cards.filter(
            (card) => card.id !== "card-a" && card.id !== "card-b",
          ),
          contents: makeDocumentSnapshot().contents.filter(
            (content) => content.cardId !== "card-a" && content.cardId !== "card-b",
          ),
        },
        "card-root",
        "card-root-child",
      ),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Only root"),
        },
        {
          cardId: "card-root-child",
          contentJson: contentJsonForPlainText("Child"),
        },
      ],
    };

    const source = removeConvertedCardFromSource(onlyRootSnapshot, "card-root");

    expect(source.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(source.contents).toEqual([
      {
        cardId: "card-root",
        contentJson: EMPTY_EDITOR_DOCUMENT_JSON,
      },
    ]);
  });

  it("suggests a filename from the selected card text", () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: makeDocumentSnapshot().contents.map((content) =>
        content.cardId === "card-a"
          ? { ...content, contentJson: contentJsonForPlainText("# A Stranger Arrives") }
          : content,
      ),
    };

    expect(defaultConvertedDocumentName(snapshot, "card-a")).toBe(
      "A Stranger Arrives.fable",
    );
  });
});
