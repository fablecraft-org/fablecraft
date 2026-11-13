import { Mark } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { PASSAGE_ANCHOR_MARK } from "../domain/document/passageAnchors";

export const PassageAnchorMark = Mark.create({
  name: PASSAGE_ANCHOR_MARK,
  inclusive: false,
  addAttributes() {
    return { childCardId: { default: null, rendered: false } };
  },
  // HTML/text paste must never import document-local card identifiers.
  parseHTML() { return []; },
  renderHTML({ mark }) {
    return ["span", {
      class: "fc-passage-anchor",
      "data-fc-child-id": mark.attrs.childCardId,
      role: "link",
      "aria-label": "Open associated child card",
    }, 0];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        decorations(state) {
          if (!editor.isEditable) return DecorationSet.empty;
          const { from, to, empty, $from } = state.selection;
          const activeIds = new Set<string>();
          if (empty) {
            $from.marks().forEach((mark) => {
              if (mark.type.name === PASSAGE_ANCHOR_MARK) activeIds.add(mark.attrs.childCardId);
            });
          } else {
            state.doc.nodesBetween(from, to, (node) => {
              node.marks.forEach((mark) => {
                if (mark.type.name === PASSAGE_ANCHOR_MARK) activeIds.add(mark.attrs.childCardId);
              });
            });
          }
          const decorations: Decoration[] = [];
          state.doc.descendants((node, position) => {
            if (node.isText && node.marks.some((mark) =>
              mark.type.name === PASSAGE_ANCHOR_MARK && activeIds.has(mark.attrs.childCardId))) {
              decorations.push(Decoration.inline(position, position + node.nodeSize, {
                class: "fc-passage-anchor-active",
              }));
            }
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
