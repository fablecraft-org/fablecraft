import { describe, expect, it } from "vitest";
import {
  createCardCopyPayload,
  createCardCutPayload,
  pasteCardClipboardPayload,
  removeCutSubtree,
} from "../src/domain/document/clipboard";
import { contentJsonForPlainText } from "../src/domain/document/content";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { createChildCard } from "../src/domain/document/tree";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

describe("document card clipboard operations", () => {
  it("copies only the selected card content", () => {
    const seedSnapshot = createChildCard(makeDocumentSnapshot(), "card-a", "card-a-1");
    const snapshot = {
      ...seedSnapshot,
      contents: seedSnapshot.contents.map((content) => {
        if (content.cardId === "card-a") {
          return { ...content, contentJson: contentJsonForPlainText("Copied card") };
        }

        if (content.cardId === "card-a-1") {
          return { ...content, contentJson: contentJsonForPlainText("Child card") };
        }

        return content;
      }),
    };

    const payload = createCardCopyPayload(snapshot, "card-a");

    expect(payload.kind).toBe("content");
    expect(payload.operation).toBe("copy");
    expect(payload.rootContentJson).toBe(contentJsonForPlainText("Copied card"));
    expect(payload).not.toHaveProperty("descendants");
  });

  it("cuts the selected card and its descendants in stable tree order", () => {
    let snapshot = createChildCard(makeDocumentSnapshot(), "card-a", "card-a-1");
    snapshot = createChildCard(snapshot, "card-a-1", "card-a-1-a");
    snapshot = createChildCard(snapshot, "card-a", "card-a-2");

    const payload = createCardCutPayload(snapshot, "card-a");

    expect(payload.kind).toBe("subtree");
    expect(payload.operation).toBe("cut");
    expect(payload.descendants.map((card) => card.id)).toEqual([
      "card-a-1",
      "card-a-1-a",
      "card-a-2",
    ]);
    expect(payload.descendants.map((card) => card.parentId)).toEqual([
      "card-a",
      "card-a-1",
      "card-a",
    ]);
  });

  it("pastes card content into an empty leaf without changing sibling order", () => {
    const payload = createCardCopyPayload(
      {
        ...makeDocumentSnapshot(),
        contents: makeDocumentSnapshot().contents.map((content) =>
          content.cardId === "card-a"
            ? { ...content, contentJson: contentJsonForPlainText("Copied beat") }
            : content,
        ),
      },
      "card-a",
    );

    const nextSnapshot = pasteCardClipboardPayload(
      makeDocumentSnapshot(),
      "card-b",
      payload,
      () => "unused",
    );
    const rootChildren = nextSnapshot.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren.map((card) => card.id)).toEqual(["card-a", "card-b"]);
    expect(
      nextSnapshot.contents.find((content) => content.cardId === "card-b")?.contentJson,
    ).toBe(contentJsonForPlainText("Copied beat"));
  });

  it("pastes a subtree onto the target card and remaps descendant ids", () => {
    let sourceSnapshot = createChildCard(makeDocumentSnapshot(), "card-a", "card-a-1");
    sourceSnapshot = createChildCard(sourceSnapshot, "card-a-1", "card-a-1-a");
    sourceSnapshot = {
      ...sourceSnapshot,
      contents: sourceSnapshot.contents.map((content) => {
        if (content.cardId === "card-a") {
          return { ...content, contentJson: contentJsonForPlainText("Moved root") };
        }

        if (content.cardId === "card-a-1") {
          return { ...content, contentJson: contentJsonForPlainText("Moved child") };
        }

        if (content.cardId === "card-a-1-a") {
          return { ...content, contentJson: contentJsonForPlainText("Moved grandchild") };
        }

        return content;
      }),
    };
    const payload = createCardCutPayload(sourceSnapshot, "card-a");
    const ids = ["card-new-1", "card-new-2"];

    const nextSnapshot = pasteCardClipboardPayload(
      makeDocumentSnapshot(),
      "card-b",
      payload,
      () => ids.shift() ?? "unexpected",
    );

    expect(
      nextSnapshot.contents.find((content) => content.cardId === "card-b")?.contentJson,
    ).toBe(contentJsonForPlainText("Moved root"));
    expect(
      nextSnapshot.cards.find((card) => card.id === "card-new-1")?.parentId,
    ).toBe("card-b");
    expect(
      nextSnapshot.cards.find((card) => card.id === "card-new-2")?.parentId,
    ).toBe("card-new-1");
    expect(
      nextSnapshot.contents.find((content) => content.cardId === "card-new-1")?.contentJson,
    ).toBe(contentJsonForPlainText("Moved child"));
    expect(
      nextSnapshot.contents.find((content) => content.cardId === "card-new-2")?.contentJson,
    ).toBe(contentJsonForPlainText("Moved grandchild"));
  });

  it("rejects non-empty targets and targets with children", () => {
    const payload = createCardCopyPayload(makeDocumentSnapshot(), "card-a");
    const nonEmptySnapshot = {
      ...makeDocumentSnapshot(),
      contents: makeDocumentSnapshot().contents.map((content) =>
        content.cardId === "card-b"
          ? { ...content, contentJson: contentJsonForPlainText("Occupied") }
          : content,
      ),
    };
    const targetWithChildrenSnapshot = createChildCard(
      makeDocumentSnapshot(),
      "card-b",
      "card-b-1",
    );

    expect(() =>
      pasteCardClipboardPayload(nonEmptySnapshot, "card-b", payload, () => "card-new"),
    ).toThrow("Paste target must be an empty card.");
    expect(() =>
      pasteCardClipboardPayload(targetWithChildrenSnapshot, "card-b", payload, () => "card-new"),
    ).toThrow("Paste target must not already have children.");
  });

  it("keeps one empty root when cutting the final root card", () => {
    const snapshot = {
      ...createChildCard(
        {
          ...makeDocumentSnapshot(),
          cards: makeDocumentSnapshot().cards.filter((card) => card.id !== "card-a" && card.id !== "card-b"),
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

    const nextSnapshot = removeCutSubtree(snapshot, "card-root");

    expect(nextSnapshot.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(nextSnapshot.contents).toEqual([
      {
        cardId: "card-root",
        contentJson: EMPTY_EDITOR_DOCUMENT_JSON,
      },
    ]);
  });
});
