import { Node, type Editor } from "@tiptap/react";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { CARD_LINK_NODE, resolveCardLabel } from "../domain/document/cardLinks";
import { CARD_CLIPBOARD_MIME_TYPE, decodeCardClipboardPayload } from "../domain/document/clipboard";

interface CardLinkOptions {
  getLabels: () => Record<string, string>;
  getDocumentId: () => string | undefined;
  onOpen: (id: string) => void;
}

export function convertTypedCardLink(editor: Editor, labels: Record<string, string>) {
  const { selection, schema, tr } = editor.state;
  const { $from } = selection;
  if (!selection.empty || $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return false;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = /(?:^|\s)(#[A-Za-z]\d+)$/.exec(before);
  const targetCardId = match ? resolveCardLabel(labels, match[1]!) : null;
  if (!match || !targetCardId) return false;
  const start = selection.from - match[1]!.length;
  tr.replaceWith(start, selection.from, [
    schema.nodes[CARD_LINK_NODE]!.create({ targetCardId, label: labels[targetCardId] }),
    schema.text(" "),
  ]);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const CardLinkNode = Node.create<CardLinkOptions>({
  name: CARD_LINK_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { getLabels: () => ({}), getDocumentId: () => undefined, onOpen: () => {} };
  },
  addAttributes() {
    return { targetCardId: { default: null, rendered: false }, label: { default: "Missing card", rendered: false } };
  },
  // HTML from another application must not import document-local ids.
  parseHTML() { return []; },
  renderHTML({ node }) {
    return ["span", { class: "fc-card-link", "data-fc-card-link": node.attrs.targetCardId }, node.attrs.label];
  },
  renderText({ node }) {
    return this.options.getLabels()[node.attrs.targetCardId] ?? node.attrs.label;
  },
  addKeyboardShortcuts() {
    const remove = (backward: boolean) => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (selection instanceof NodeSelection && selection.node.type.name === CARD_LINK_NODE) {
        view.dispatch(state.tr.deleteSelection().scrollIntoView());
        return true;
      }
      if (!selection.empty) return false;
      const adjacent = backward ? selection.$from.nodeBefore : selection.$from.nodeAfter;
      if (adjacent?.type.name !== CARD_LINK_NODE) return false;
      const from = backward ? selection.from - adjacent.nodeSize : selection.from;
      view.dispatch(state.tr.delete(from, from + adjacent.nodeSize).scrollIntoView());
      return true;
    };
    return { Backspace: () => remove(true), Delete: () => remove(false) };
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "fc-card-link";
      dom.dataset.fcCardLink = node.attrs.targetCardId;
      dom.dataset.fcLinkFallback = node.attrs.label;
      dom.contentEditable = "false";
      dom.setAttribute("role", "link");
      dom.tabIndex = 0;
      dom.textContent = this.options.getLabels()[node.attrs.targetCardId] ?? node.attrs.label;
      return { dom };
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [new Plugin({
      props: {
        handlePaste(view, event) {
          const payload = decodeCardClipboardPayload(event.clipboardData?.getData(CARD_CLIPBOARD_MIME_TYPE) ?? "")
            ?? decodeCardClipboardPayload(event.clipboardData?.getData("text/plain") ?? "");
          if (!payload || payload.operation !== "copy") return false;
          event.preventDefault();
          const label = options.getLabels()[payload.source.rootCardId];
          if (payload.source.documentId !== options.getDocumentId() || !label) return true;
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes[CARD_LINK_NODE]!.create({
            targetCardId: payload.source.rootCardId, label,
          })).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          click(_view, event) {
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-fc-card-link]") : null;
            if (!target) return false;
            event.preventDefault();
            event.stopPropagation();
            const id = target.dataset.fcCardLink!;
            if (options.getLabels()[id]) options.onOpen(id);
            return true;
          },
          keydown(_view, event) {
            const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-fc-card-link]") : null;
            if (!target || (event.key !== "Enter" && event.key !== " ")) return false;
            event.preventDefault();
            event.stopPropagation();
            const id = target.dataset.fcCardLink!;
            if (options.getLabels()[id]) options.onOpen(id);
            return true;
          },
        },
      },
      view(view) {
        const refresh = () => view.dom.querySelectorAll<HTMLElement>("[data-fc-card-link]").forEach((dom) => {
          const label = options.getLabels()[dom.dataset.fcCardLink!];
          const text = label ?? dom.dataset.fcLinkFallback ?? "Missing card";
          if (dom.textContent !== text) dom.textContent = text;
          dom.classList.toggle("fc-card-link-missing", !label);
          dom.setAttribute("aria-label", label ? `Open card ${label}` : "Missing card");
          dom.setAttribute("aria-disabled", String(!label));
        });
        refresh();
        return { update: refresh };
      },
    })];
  },
});
