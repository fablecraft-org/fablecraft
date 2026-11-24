import { getSchema, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "./editorDocument";

export function proseExtensions() {
  return [StarterKit.configure({ undoRedo: false, trailingNode: false, link: { openOnClick: false } })];
}

export const manuscriptSchema = getSchema(proseExtensions());

const markdown = new MarkdownIt("commonmark", { html: false }).enable("strikethrough");

// Only these formatting tags are interpreted, as schema nodes or marks.
markdown.inline.ruler.before("html_inline", "fablecraft_underline", (state, silent) => {
  if (state.src.startsWith("<br>", state.pos) && state.pos + 4 <= state.posMax) {
    if (!silent) state.push("hardbreak", "br", 0);
    state.pos += 4;
    return true;
  }
  if (!state.src.startsWith("<u>", state.pos)) return false;
  const close = state.src.indexOf("</u>", state.pos + 3);
  if (close < 0 || close >= state.posMax) return false;
  if (!silent) {
    state.push("underline_open", "u", 1);
    const end = state.posMax;
    state.pos += 3;
    state.posMax = close;
    state.md.inline.tokenize(state);
    state.posMax = end;
    state.push("underline_close", "u", -1);
  }
  state.pos = close + 4;
  return true;
});

markdown.core.ruler.after("inline", "literal_images", (state) => {
  for (const token of state.tokens) {
    for (const inline of token.children ?? []) {
      if (inline.type !== "image") continue;
      const title = inline.attrGet("title");
      inline.type = "text";
      inline.content = `![${inline.content}](${inline.attrGet("src") ?? ""}${title ? ` "${title}"` : ""})`;
      (state.env as { literalImages?: boolean }).literalImages = true;
    }
  }
});

const parser = new MarkdownParser(manuscriptSchema, markdown, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  ordered_list: { block: "orderedList", getAttrs: (token) => ({ start: Number(token.attrGet("start") ?? 1) }) },
  heading: { block: "heading", getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  code_block: { block: "codeBlock" },
  fence: { block: "codeBlock", getAttrs: (token) => ({ language: token.info || null }) },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  s: { mark: "strike" },
  underline: { mark: "underline" },
  link: { mark: "link", getAttrs: (token) => ({ href: token.attrGet("href"), title: token.attrGet("title") }) },
  code_inline: { mark: "code" },
});

const { nodes, marks } = defaultMarkdownSerializer;
const serializer = new MarkdownSerializer({
  blockquote: nodes.blockquote!,
  codeBlock(state, node) {
    const runs = node.textContent.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    state.write(fence + (node.attrs.language ?? "").replace(/[`\r\n]/g, "") + "\n");
    state.text(node.textContent, false);
    state.write("\n" + fence);
    state.closeBlock(node);
  },
  heading: nodes.heading!,
  horizontalRule: nodes.horizontal_rule!,
  bulletList: nodes.bullet_list!,
  orderedList(state, node) {
    const start = Number(node.attrs.start ?? 1);
    const width = String(start + node.childCount - 1).length;
    state.renderList(node, " ".repeat(width + 2), (i) => `${String(start + i).padStart(width)}. `);
  },
  listItem: nodes.list_item!,
  paragraph: nodes.paragraph!,
  hardBreak(state, _node, parent, index) {
    const next = parent.maybeChild(index + 1);
    state.write(!next || next.type.name === "hardBreak" ? "<br>" : "\\\n");
  },
  text: nodes.text!,
}, {
  italic: marks.em!,
  bold: marks.strong!,
  link: marks.link!,
  code: marks.code!,
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  underline: { open: "<u>", close: "</u>" },
}, { hardBreakNodeName: "hardBreak", escapeExtraCharacters: /[<>~]/g });

export function parseManuscriptMarkdown(source: string) {
  if (source.includes("\0")) throw new Error("The Markdown file contains a NUL character.");
  const env: { literalImages?: boolean } = {};
  const doc = source.trim() ? parser.parse(source.replace(/^\uFEFF/u, ""), env)
    : manuscriptSchema.nodeFromJSON(JSON.parse(EMPTY_EDITOR_DOCUMENT_JSON));
  doc.check();
  return { contentJson: JSON.stringify(doc.toJSON()), loss: env.literalImages
    ? "Images will be imported as Markdown source text." : null };
}

export function exportManuscriptMarkdown(contentJson: string) {
  const doc = manuscriptSchema.nodeFromJSON(JSON.parse(contentJson));
  doc.check();
  return serializer.serialize(doc);
}

export function cardProse(contentJson: string, schema: Schema) {
  function clean(node: JSONContent): JSONContent {
    if (node.type === "cardLink") return { type: "text", text: node.attrs?.label || "?" };
    return {
      ...node,
      content: node.content?.map(clean),
      marks: node.marks?.filter((mark) => mark.type !== "passageAnchor"),
    };
  }
  const doc = schema.nodeFromJSON(clean(JSON.parse(contentJson)));
  doc.check();
  return doc;
}
