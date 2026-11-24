import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type HistoryTextRange = { from: number; to: number };
export const historyAddedClass = "fc-history-text-added";

const key = new PluginKey<DecorationSet>("historyAdditions");

export const HistoryAdditions = Extension.create({
  name: "historyAdditions",
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, current) {
          const ranges = transaction.getMeta(key) as readonly HistoryTextRange[] | undefined;
          if (!ranges) return transaction.docChanged ? DecorationSet.empty : current;
          return DecorationSet.create(transaction.doc, ranges
            .filter(({ from, to }) => from < to && to <= transaction.doc.content.size)
            .map(({ from, to }) => Decoration.inline(from, to, { class: historyAddedClass })));
        },
      },
      props: { decorations: (state) => key.getState(state) },
    })];
  },
});

export function showHistoryAdditions(editor: Editor, ranges: readonly HistoryTextRange[]) {
  editor.view.dispatch(editor.state.tr.setMeta(key, ranges).setMeta("addToHistory", false));
}
