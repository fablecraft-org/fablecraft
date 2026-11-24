import { AllSelection, EditorState, TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import {
  addManuscriptTarget, mapManuscriptPassages, manuscriptUuid, passageIndex, selectedPassageRange,
} from "../src/domain/document/manuscript";
import { cutPassageRanges, pasteCutPassages } from "../src/domain/document/manuscriptClipboard";
import {
  cardProse, exportManuscriptMarkdown, manuscriptSchema, parseManuscriptMarkdown,
} from "../src/domain/document/manuscriptMarkdown";
import { paneShortcut, splitMinimumWidth, stepWorkspace } from "../src/domain/document/manuscriptLayout";
import type { ManuscriptPassage } from "../src/domain/document/types";

function docFor(source: string) {
  return manuscriptSchema.nodeFromJSON(JSON.parse(parseManuscriptMarkdown(source).contentJson));
}

function link(from: number, to: number, targetCardIds = ["A"]): ManuscriptPassage {
  return { from, to, targetCardIds, id: manuscriptUuid() };
}

describe("manuscript passages", () => {
  it("maps all four edges of overlapping ranges with UTF-16 coordinates", () => {
    const state = EditorState.create({ doc: docFor("a😀bcdéfg") });
    const a = link(2, 7, ["A", "B"]);
    const b = link(5, 10, ["B", "C"]);
    for (const [edge, expected] of [
      [2, [[3, 8], [6, 11]]],
      [5, [[2, 8], [6, 11]]],
      [7, [[2, 7], [5, 11]]],
      [10, [[2, 7], [5, 10]]],
    ] as const) {
      const mapped = mapManuscriptPassages([a, b], state.tr.insertText("!", edge));
      expect(mapped.map(({ from, to }) => [from, to])).toEqual(expected);
      expect(mapped.map(({ id }) => id)).toEqual([a.id, b.id]);
    }
  });

  it("preserves separately identified passages on replacement and restores removed spans only through history", () => {
    const state = EditorState.create({ doc: docFor("one two three") });
    const a = link(1, 8);
    const b = link(5, 8, ["B"]);
    const replaced = mapManuscriptPassages([a, b], state.tr.insertText("hey", 1, 8));
    expect(replaced).toEqual([{ ...a, to: 4 }, { ...b, from: 1, to: 4 }]);
    const cut = state.tr.delete(1, 8);
    expect(mapManuscriptPassages([a, b], cut)).toEqual([]);
  });

  it("replaces the target on an exact range and leaves repeated pairings untouched", () => {
    const doc = docFor("One. Two.");
    const all = new AllSelection(doc);
    const range = selectedPassageRange(doc, all.from, all.to)!;
    expect(range).toEqual({ from: 1, to: 10 });
    const initial = { id: manuscriptUuid(), contentJson: JSON.stringify(doc.toJSON()), passages: [] };
    const first = addManuscriptTarget(initial, doc, range.from, range.to, "A");
    const second = addManuscriptTarget(first, doc, range.from, range.to, "B");
    expect(second.passages).toEqual([{ ...first.passages[0], targetCardIds: ["B"] }]);
    expect(addManuscriptTarget(second, doc, range.from, range.to, "B")).toBe(second);
  });

  it("splits an older range around the newest link without moving the original ID", () => {
    const doc = docFor("Alpha beta gamma.");
    const initial = { id: manuscriptUuid(), contentJson: JSON.stringify(doc.toJSON()), passages: [link(1, 18)] };
    const linked = addManuscriptTarget(initial, doc, 7, 11, "B");
    const ranges = linked.passages.map(({ from, to, targetCardIds }) => [from, to, targetCardIds]);
    expect(ranges).toEqual([[1, 7, ["A"]], [11, 18, ["A"]], [7, 11, ["B"]]]);
    expect(linked.passages[0]?.id).toBe(initial.passages[0]?.id);
    expect(new Set(linked.passages.map(({ id }) => id)).size).toBe(3);
  });

  it("derives identical labels for separate sentences, and counts hard breaks, blank blocks and literal code newlines", () => {
    const doc = manuscriptSchema.nodeFromJSON({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "One. Two." }, { type: "hardBreak" },
        { type: "text", text: "Three." }] },
      { type: "paragraph" },
      { type: "codeBlock", content: [{ type: "text", text: "four\nfive" }] },
    ] });
    const first = link(1, 5);
    const second = link(6, 10);
    const third = link(11, 17);
    const code = link(21, 30);
    expect(passageIndex(doc, [code, second, first, third]).map(({ id, lines, excerpt }) => [id, lines, excerpt]))
      .toEqual([[first.id, "L1", "One."], [second.id, "L1", "Two."],
        [third.id, "L2", "Three."], [code.id, "L4–5", "four five"]]);
    const tr = EditorState.create({ doc }).tr.insert(0, manuscriptSchema.nodes.paragraph!.create());
    expect(passageIndex(tr.doc, mapManuscriptPassages([first, second], tr)).map(({ lines }) => lines))
      .toEqual(["L2", "L2"]);
  });
});

describe("manuscript clipboard ranges", () => {
  it("matches inserted positions after a cross-block cut, preserving whole identities and splitting partial intersections", () => {
    const doc = docFor("Alpha 😀\n\nBeta two\n\nGamma");
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 4, 17) });
    const whole = link(7, 15, ["B", "C"]);
    const partial = link(1, 13, ["A", "B"]);
    const late = link(14, 22, ["C"]);
    const fragment = cutPassageRanges(doc, state.selection.from, state.selection.to, [whole, partial, late]);
    const slice = state.selection.content();
    const cut = { fragment, slice, token: "cut", documentKey: "story", manuscriptId: "manuscript", anchor: {} };
    const deletion = state.tr.deleteSelection();
    const mapped = mapManuscriptPassages([whole, partial, late], deletion);
    const after = state.apply(deletion);
    const end = TextSelection.atEnd(after.doc);
    const paste = after.tr.setSelection(end).replaceSelection(slice);
    const results = pasteCutPassages(paste, cut, mapped, new Set(["A", "B"]))!;
    expect(results.find((item) => item.id === whole.id)?.targetCardIds).toEqual(["B"]);
    expect(results.find((item) => item.id === partial.id)?.targetCardIds).toEqual(["A", "B"]);
    const copiedFragment = results.find((item) => ![whole.id, partial.id, late.id].includes(item.id));
    expect(copiedFragment?.targetCardIds).toEqual(["A", "B"]);
    expect(results.filter((item) => item.id !== late.id).every((item) => !item.targetCardIds.includes("C"))).toBe(true);
    expect(pasteCutPassages(after.tr.replaceSelection(Slice.empty), cut, mapped, new Set(["A"]))).toBeNull();
  });
});

describe("manuscript Markdown", () => {
  it("round trips nested lists, headings, marks, URLs, literal punctuation, breaks, quotes and fenced code", () => {
    const source = "# Heading\n\n**Bold** *italic* ~~strike~~ <u>under</u> [URL](https://example.com/a) `code` " +
      "\\*literal\\* \\[brackets\\]\\\nHard break 😀.\n\n3. First\n   - Nested\n4. Last\n\n> Quoted.\n\n" +
      "````text\nFirst ```\nSecond\n````";
    const parsed = parseManuscriptMarkdown(source);
    const exported = exportManuscriptMarkdown(parsed.contentJson);
    expect(parseManuscriptMarkdown(exported).contentJson).toBe(parsed.contentJson);
    expect(exported).toContain("https://example.com/a");
    expect(exported).toContain("````text");
  });

  it("preserves consecutive and trailing hard breaks and optional link titles", () => {
    const parsed = parseManuscriptMarkdown('[Named](https://example.com "Title")<br><br>second<br>');
    expect(parseManuscriptMarkdown(exportManuscriptMarkdown(parsed.contentJson)).contentJson).toBe(parsed.contentJson);
  });

  it("keeps raw HTML literal, reports images and accepts an empty manuscript", () => {
    const input = parseManuscriptMarkdown('<script>alert(1)</script>\n\n![Cover](cover.png)');
    const doc = manuscriptSchema.nodeFromJSON(JSON.parse(input.contentJson));
    expect(doc.textContent).toContain("<script>alert(1)</script>");
    expect(doc.textContent).toContain("![Cover](cover.png)");
    expect(input.loss).toMatch(/Images/u);
    expect(exportManuscriptMarkdown(parseManuscriptMarkdown("").contentJson)).toBe("");
    expect(() => parseManuscriptMarkdown("Invalid\0")).toThrow(/NUL/u);
  });

  it("converts card chips to labels while preserving prose and formatting", () => {
    const rich = cardProse(JSON.stringify({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [
      { type: "text", text: "Idea ", marks: [{ type: "bold" }, { type: "passageAnchor", attrs: { childCardId: "child" } }] },
      { type: "cardLink", attrs: { label: "B03", targetCardId: "sensitive-card-id" } },
    ] }] }), manuscriptSchema);
    expect(rich.textContent).toBe("Idea B03");
    expect(rich.firstChild?.firstChild?.marks.map(({ type }) => type.name)).toEqual(["bold"]);
    expect(JSON.stringify(rich.toJSON())).not.toContain("sensitive-card-id");
  });
});

describe("manuscript workspace navigation", () => {
  it("implements all direction transitions and endpoints, maintaining a collapsed split at the narrow endpoint", () => {
    expect(splitMinimumWidth).toBeGreaterThan(408);
    expect(stepWorkspace("tree", "tree", -1, true)).toEqual({ layout: "tree", pane: "tree" });
    expect(stepWorkspace("tree", "tree", 1, true)).toEqual({ layout: "both", pane: "manuscript" });
    expect(stepWorkspace("both", "tree", -1, true)).toEqual({ layout: "tree", pane: "tree" });
    expect(stepWorkspace("both", "tree", 1, true)).toEqual({ layout: "both", pane: "manuscript" });
    expect(stepWorkspace("both", "manuscript", -1, true)).toEqual({ layout: "both", pane: "tree" });
    expect(stepWorkspace("both", "manuscript", 1, true)).toEqual({ layout: "manuscript", pane: "manuscript" });
    expect(stepWorkspace("manuscript", "manuscript", -1, true)).toEqual({ layout: "both", pane: "tree" });
    expect(stepWorkspace("manuscript", "manuscript", 1, true)).toEqual({ layout: "manuscript", pane: "manuscript" });
    expect(stepWorkspace("both", "manuscript", 1, false)).toEqual({ layout: "both", pane: "manuscript" });
    expect(stepWorkspace("both", "manuscript", -1, false)).toEqual({ layout: "tree", pane: "tree" });
    expect(stepWorkspace("tree", "tree", 1, false)).toEqual({ layout: "manuscript", pane: "manuscript" });
  });

  it("requires the platform's complete unshifted chord and yields to composition", () => {
    const key = (input: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "ArrowLeft", ...input });
    expect(paneShortcut(key({ metaKey: true, altKey: true }), true)).toBe(-1);
    expect(paneShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(-1);
    expect(paneShortcut(key({ metaKey: true }), true)).toBeNull();
    expect(paneShortcut(key({ altKey: true }), false)).toBeNull();
    expect(paneShortcut(key({ ctrlKey: true, altKey: true, shiftKey: true }), false)).toBeNull();
    expect(paneShortcut(key({ ctrlKey: true, altKey: true, isComposing: true }), false)).toBeNull();
  });
});
