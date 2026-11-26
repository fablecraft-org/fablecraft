import { Extension, type Editor } from "@tiptap/core";
import { Slice, type Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { CARD_CLIPBOARD_MIME_TYPE, decodeCardClipboardPayload } from "../domain/document/clipboard";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../domain/document/editorDocument";
import {
  addManuscriptTarget, hasPassageText, mapManuscriptPassages, manuscriptUuid, resolveManuscriptOverlaps, selectedPassageRange,
  type PassageEntry,
} from "../domain/document/manuscript";
import {
  cutPassageRanges, MANUSCRIPT_CUT_MIME, pasteCutPassages, type ManuscriptCut,
} from "../domain/document/manuscriptClipboard";
import { mapManuscriptParagraphStart, manuscriptParagraphAt, typedManuscriptCardId } from "../domain/document/manuscriptCardIds";
import { cardProse, proseExtensions } from "../domain/document/manuscriptMarkdown";
import type { DocumentSnapshot, Manuscript, ManuscriptPassage } from "../domain/document/types";
import { useDocumentStore } from "../state/documentStore";
import { HistoryAdditions, showHistoryAdditions, type HistoryTextRange } from "./historyAdditions";

type Range = { from: number; to: number };
const searchHighlightKey = new PluginKey<Range | null>("manuscriptSearchHighlight");
let pendingCut: (ManuscriptCut & { session: number; saved: boolean }) | null = null;

const SearchHighlight = Extension.create({
  name: "manuscriptSearchHighlight",
  addProseMirrorPlugins() {
    return [new Plugin<Range | null>({
      key: searchHighlightKey,
      state: {
        init: () => null,
        apply: (tr, current) => tr.getMeta(searchHighlightKey) !== undefined
          ? tr.getMeta(searchHighlightKey) : tr.docChanged ? null : current,
      },
      props: {
        decorations(state) {
          const range = searchHighlightKey.getState(state);
          return range && range.to <= state.doc.content.size
            ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: "fc-manuscript-search-highlight" })])
            : DecorationSet.empty;
        },
      },
    })];
  },
});

interface TypedParagraph {
  cardId: string;
  from: number;
  passageId?: string;
}

const typedCardKey = new PluginKey("manuscriptCardIdInput");

const ManuscriptCardIdInput = Extension.create<{ getLabels: () => Record<string, string> }>({
  name: "manuscriptCardIdInput",
  addOptions() {
    return { getLabels: () => ({}) };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: typedCardKey,
      appendTransaction: (transactions, _previous, state) => {
        const input = transactions[0];
        if (!input || transactions.length !== 1 || input.getMeta(typedCardKey)) return null;
        const token = typedManuscriptCardId(input, this.options.getLabels());
        if (!token) return null;
        return state.tr.delete(token.from, token.to)
          .setMeta(typedCardKey, { cardId: token.cardId, from: token.paragraphStart } satisfies TypedParagraph);
      },
    })];
  },
});

export interface ManuscriptPaneHandle {
  focus: () => void;
  write: () => void;
  link: () => boolean;
  confirmLink: (cardId: string) => boolean;
  clearLink: (restoreSelection?: boolean) => void;
  search: () => void;
  composing: () => boolean;
  documentFor: (contentJson: string) => ProseNode | null;
}

interface ManuscriptPaneProps {
  readOnly?: boolean;
  ref: Ref<ManuscriptPaneHandle>;
  snapshot: DocumentSnapshot;
  active: boolean;
  visible: boolean;
  entries: PassageEntry[];
  labels: Record<string, string>;
  reveal: (Range & { request: number }) | null;
  historyAdditions?: readonly HistoryTextRange[];
  onActivate: () => void;
  onNavigateDirectory: () => boolean;
  onNotice: (message: string) => void;
  choosingCard: boolean;
  typographyKey: string;
  onLinkInvalidated: () => void;
  onLinkEligibilityChange: (eligible: boolean) => void;
  onLinkedCardChange: (cardId: string | null) => void;
}

function setSelection(editor: Editor, range: Range, highlight = false) {
  const { doc, tr } = editor.state;
  if (range.to > doc.content.size) return;
  const selection = TextSelection.between(doc.resolve(range.from), doc.resolve(range.to));
  editor.view.dispatch(tr.setSelection(selection).setMeta(searchHighlightKey, highlight ? range : null).scrollIntoView());
}

function keyFor(snapshot: DocumentSnapshot) {
  return `${snapshot.summary.documentId}:${snapshot.summary.path}`;
}

function escapePattern(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ManuscriptPane(props: ManuscriptPaneProps) {
  const { active, visible, snapshot, entries, reveal, historyAdditions, readOnly = false } = props;
  const prose = snapshot.manuscript;
  const latest = useRef(props);
  latest.current = props;
  const writing = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const editorJson = useRef<{ editor: Editor; content: string } | null>(null);
  const typingParagraph = useRef<TypedParagraph | null>(null);
  const [emptyLinkedParagraph, setEmptyLinkedParagraph] = useState<number | null>(null);
  const pendingLink = useRef<(Range & { manuscriptId: string; selection: Selection }) | null>(null);
  const [marginBars, setMarginBars] = useState<{ top: number; bottom: number }[]>([]);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [selection, setCurrentSelection] = useState<Range>({ from: 1, to: 1 });
  const focusWhenReady = useRef(false);
  const syncing = useRef(false);
  const documentKey = keyFor(snapshot);
  const contentJson = prose?.contentJson ?? EMPTY_EDITOR_DOCUMENT_JSON;

  function currentSnapshot() {
    if (latest.current.readOnly) return latest.current.snapshot;
    const current = useDocumentStore.getState().snapshot;
    return current && keyFor(current) === keyFor(latest.current.snapshot) ? current : null;
  }

  function updateManuscript(update: (current: Manuscript | null) => Manuscript | null) {
    if (latest.current.readOnly) return;
    useDocumentStore.getState().updateSnapshot((current) => {
      if (keyFor(current) !== keyFor(latest.current.snapshot)) return current;
      const manuscript = update(current.manuscript ?? null);
      return manuscript === (current.manuscript ?? null) ? current : { ...current, manuscript };
    });
  }

  function applyPaste(event: ClipboardEvent) {
    const editor = editorRef.current;
    const clipboard = event.clipboardData;
    if (event.defaultPrevented || !editor || !clipboard || pendingLink.current) return false;
    const payload = decodeCardClipboardPayload(clipboard.getData(CARD_CLIPBOARD_MIME_TYPE)) ??
      decodeCardClipboardPayload(clipboard.getData("text/plain"));
    if (payload) {
      event.preventDefault();
      try {
        const slice = new Slice(cardProse(payload.rootContentJson, editor.schema).content, 0, 0);
        const { tr, doc } = editor.state;
        const paste = currentSnapshot()?.manuscript
          ? tr.replaceSelection(Slice.maxOpen(slice.content))
          : tr.replace(0, doc.content.size, slice);
        editor.view.dispatch(paste.setMeta("uiEvent", "paste").scrollIntoView());
      } catch (error) {
        latest.current.onNotice(error instanceof Error ? error.message : "Could not paste card prose.");
      }
      return true;
    }

    const cut = pendingCut;
    const state = useDocumentStore.getState();
    const current = currentSnapshot();
    const token = clipboard.getData(MANUSCRIPT_CUT_MIME) ||
      /data-fc-manuscript-cut="([a-f0-9-]+)"/.exec(clipboard.getData("text/html"))?.[1];
    if (!cut || token !== cut.token || !current?.manuscript || cut.documentKey !== keyFor(current) || cut.manuscriptId !== current.manuscript.id) return false;

    const knownCut = cut.session === state.session
      ? state.chronologicalPast.some((entry) => entry.manuscript === cut.anchor) || current.manuscript === cut.anchor
      : cut.saved;
    if (!knownCut) return false;

    const tr = editor.state.tr.replaceSelection(Slice.fromJSON(editor.schema, cut.slice.toJSON()));
    const passages = pasteCutPassages(tr, cut, current.manuscript.passages,
      new Set(current.cards.map((card) => card.id)));
    if (!passages) return false;
    event.preventDefault();
    editor.view.dispatch(tr.setMeta("manuscriptPassages", passages).setMeta("uiEvent", "paste").scrollIntoView());
    pendingCut = null;
    return true;
  }

  function cutSelection(event: ClipboardEvent) {
    const editor = editorRef.current;
    const current = currentSnapshot();
    const clipboard = event.clipboardData;
    if (!editor || !current?.manuscript || !clipboard || pendingLink.current) return false;
    const { doc, selection, tr } = editor.state;
    if (selection.empty) return false;
    const slice = selection.content();
    const fragment = cutPassageRanges(doc, selection.from, selection.to, current.manuscript.passages);
    const token = manuscriptUuid();
    const serialized = editor.view.serializeForClipboard(slice);
    serialized.dom.firstElementChild?.setAttribute("data-fc-manuscript-cut", token);
    clipboard.clearData();
    clipboard.setData("text/html", serialized.dom.innerHTML);
    clipboard.setData("text/plain", serialized.text);
    try { clipboard.setData(MANUSCRIPT_CUT_MIME, token); } catch { /* HTML carries the same clipboard token. */ }
    event.preventDefault();
    editor.view.dispatch(tr.deleteSelection().setMeta("uiEvent", "cut").scrollIntoView());
    const anchor = currentSnapshot()?.manuscript;
    if (anchor && anchor !== current.manuscript) {
      pendingCut = {
        token, slice, fragment, anchor, manuscriptId: anchor.id, saved: false,
        documentKey: keyFor(current), session: useDocumentStore.getState().session,
      };
    }
    return true;
  }

  const editor = useEditor({
    editable: !readOnly,
    content: JSON.parse(contentJson),
    extensions: [
      ...proseExtensions(),
      SearchHighlight,
      HistoryAdditions,
      ManuscriptCardIdInput.configure({ getLabels: () => syncing.current || latest.current.readOnly ? {} : latest.current.labels }),
    ],
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "fc-editor fc-manuscript-editor", "aria-label": "Manuscript text", role: "textbox", "aria-multiline": "true",
        ...(readOnly ? { tabindex: "-1", "aria-readonly": "true" } : {}) },
      handleDOMEvents: {
        paste: (_view, event) => latest.current.readOnly || applyPaste(event),
        cut: (_view, event) => latest.current.readOnly || cutSelection(event),
      },
      transformPastedHTML: (html) => html
        .replace(/<span([^>]*data-fc-card-link[^>]*)>([\s\S]*?)<\/span>/gi, "$2"),
    },
    onTransaction({ editor, transaction, appendedTransactions }) {
      if (syncing.current) return;
      if (transaction.selectionSet || transaction.docChanged || appendedTransactions.length) {
        const { from, to } = editor.state.selection;
        setCurrentSelection({ from, to });
      }
      if (latest.current.readOnly || !transaction.docChanged && !appendedTransactions.some((step) => step.docChanged)) return;
      updateManuscript((current) => {
        let passages = current?.passages ?? [];
        let tracked = typingParagraph.current;
        for (const change of [transaction, ...appendedTransactions]) {
          const pastedLinks = change.getMeta("manuscriptPassages") as ManuscriptPassage[] | undefined;
          passages = pastedLinks ?? mapManuscriptPassages(passages, change);
          if (tracked) {
            const from = pastedLinks || change.getMeta("uiEvent") === "cut"
              ? null : mapManuscriptParagraphStart(change, tracked.from);
            tracked = from !== null ? { ...tracked, from } : null;
          }
          const shortcut = change.getMeta(typedCardKey) as TypedParagraph | undefined;
          if (shortcut) tracked = shortcut;
        }

        const doc = editor.state.doc;
        const contentJson = JSON.stringify(editor.getJSON());
        editorJson.current = { editor, content: contentJson };
        let next: Manuscript = { id: current?.id ?? manuscriptUuid(), contentJson, passages };
        const paragraph = tracked && manuscriptParagraphAt(doc, tracked.from);
        if (tracked && currentSnapshot()?.cards.some(({ id }) => id === tracked?.cardId) &&
          paragraph && paragraph.from === tracked.from) {
          const { from, to } = paragraph;
          const hasText = hasPassageText(doc, from, to);
          const passageId = tracked.passageId;
          if (hasText && passageId) {
            next.passages = passages.map((passage) => passage.id === passageId ? { ...passage, from, to } : passage);
          } else if (hasText) {
            next = addManuscriptTarget(next, doc, from, to, tracked.cardId);
          }
          next.passages = resolveManuscriptOverlaps(doc, next.passages);
          const linked = next.passages.find((passage) => passage.from === from && passage.to === to &&
            passage.targetCardIds[0] === tracked?.cardId);
          const keepTyping = editor.state.selection.from >= from && editor.state.selection.from <= to;
          typingParagraph.current = keepTyping && (linked || !hasText)
            ? { ...tracked, passageId: linked?.id } : null;
          setEmptyLinkedParagraph(keepTyping && !hasText ? from : null);
        } else {
          next.passages = resolveManuscriptOverlaps(doc, passages);
          typingParagraph.current = null;
          setEmptyLinkedParagraph(null);
        }
        if (contentJson === (current?.contentJson ?? EMPTY_EDITOR_DOCUMENT_JSON) &&
          next.passages === (current?.passages ?? passages)) return current;
        return next;
      });
    },
  }, [documentKey]);
  editorRef.current = editor;

  function focus() {
    if (!editor) focusWhenReady.current = true;
    else if (latest.current.readOnly) editor.view.dom.focus({ preventScroll: true });
    else editor.view.focus();
  }

  function clearLink(restoreSelection = false) {
    const pending = pendingLink.current;
    pendingLink.current = null;
    if (restoreSelection && pending && editor && pending.selection.$from.doc === editor.state.doc) {
      editor.view.dispatch(editor.state.tr.setSelection(pending.selection));
    }
  }

  function confirmLink(cardId: string) {
    const range = pendingLink.current;
    const current = currentSnapshot();
    if (!range || current?.manuscript?.id !== range.manuscriptId || !current.cards.some(({ id }) => id === cardId) ||
      !editor || !hasPassageText(editor.state.doc, range.from, range.to)) return false;
    updateManuscript((current) => current ? addManuscriptTarget(current, editor.state.doc, range.from, range.to, cardId) : null);
    return true;
  }

  function beginLink() {
    const manuscript = currentSnapshot()?.manuscript;
    if (!editor || !manuscript || editor.view.composing || pendingLink.current || search) return false;
    const { from, to } = editor.state.selection;
    const range = selectedPassageRange(editor.state.doc, from, to);
    if (!range) return false;
    typingParagraph.current = null;
    setEmptyLinkedParagraph(null);
    pendingLink.current = { ...range, manuscriptId: manuscript.id, selection: editor.state.selection };
    const caret = TextSelection.near(editor.state.doc.resolve(range.from));
    editor.view.dispatch(editor.state.tr.setSelection(caret).setMeta(searchHighlightKey, null));
    return true;
  }

  function write() {
    updateManuscript((current) => current ?? { id: manuscriptUuid(), contentJson: EMPTY_EDITOR_DOCUMENT_JSON, passages: [] });
  }

  useImperativeHandle(props.ref, () => ({
    focus, write, link: beginLink, confirmLink, clearLink,
    search: () => { if (prose && !pendingLink.current) setSearch(true); },
    composing: () => Boolean(editor?.view.composing),
    documentFor: (contentJson) => editor && editorJson.current?.editor === editor &&
      editorJson.current.content === contentJson ? editor.state.doc : null,
  }));

  useLayoutEffect(() => {
    if (!editor) return;
    if (pendingLink.current && pendingLink.current.manuscriptId !== prose?.id) {
      clearLink();
      latest.current.onLinkInvalidated();
    }
    if (editorJson.current?.editor === editor && editorJson.current.content === contentJson) return;
    editorJson.current = { editor, content: contentJson };
    const doc = editor.schema.nodeFromJSON(JSON.parse(contentJson));
    if (editor.state.doc.eq(doc)) return;
    typingParagraph.current = null;
    setEmptyLinkedParagraph(null);
    const { anchor, head } = editor.state.selection;
    syncing.current = true;
    try {
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content);
      const bounded = (pos: number) => tr.doc.resolve(Math.min(pos, tr.doc.content.size));
      tr.setSelection(TextSelection.between(bounded(anchor), bounded(head))).setMeta(searchHighlightKey, null);
      editor.view.dispatch(tr);
    } finally {
      syncing.current = false;
    }
    setCurrentSelection(editor.state.selection);
    if (pendingLink.current) {
      clearLink();
      latest.current.onLinkInvalidated();
    }
  }, [editor, contentJson, prose?.id]);

  useLayoutEffect(() => {
    if (!visible || !active) {
      focusWhenReady.current = false;
      return;
    }
    if (editor && focusWhenReady.current) {
      focusWhenReady.current = false;
      focus();
    }
  }, [editor, visible, active]);

  useLayoutEffect(() => {
    if (!editor || !reveal || !visible || !active) return;
    if (readOnly) {
      const pane = paneRef.current;
      if (pane && reveal.from <= editor.state.doc.content.size) {
        const { top, bottom } = editor.view.coordsAtPos(reveal.from);
        const paneTop = pane.getBoundingClientRect().top + pane.clientTop;
        pane.scrollTop += (top + bottom) / 2 - paneTop - pane.clientHeight / 2;
      }
    } else {
      setSelection(editor, { from: reveal.from, to: reveal.from });
      editor.view.focus();
    }
  }, [editor, reveal, visible, active, readOnly]);

  useLayoutEffect(() => {
    if (readOnly && editor) showHistoryAdditions(editor, historyAdditions ?? []);
  }, [editor, readOnly, historyAdditions, contentJson]);

  useEffect(() => {
    if (!active) setSearch(false);
  }, [active]);

  useEffect(() => {
    if (search) searchInput.current?.focus();
  }, [search]);

  useEffect(() => readOnly ? undefined : useDocumentStore.subscribe((state, previous) => {
    const cut = pendingCut;
    if (!cut || cut.session !== state.session) return;
    const known = state.snapshot?.manuscript === cut.anchor ||
      state.chronologicalPast.some((entry) => entry.manuscript === cut.anchor);
    if (known && state.lastSavedAtMs !== previous.lastSavedAtMs && !state.dirty) cut.saved = true;
    if (!known && state.chronologicalFuture.length > previous.chronologicalFuture.length) pendingCut = null;
  }), [readOnly]);

  useLayoutEffect(() => {
    const surface = writing.current;
    if (!visible || !editor || !surface || (!entries.length && emptyLinkedParagraph === null)) return;
    const ranges: Range[] = [];
    for (const { from, to } of entries) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous.to >= from) previous.to = Math.max(previous.to, to);
      else ranges.push({ from, to });
    }

    if (emptyLinkedParagraph !== null) ranges.push({ from: emptyLinkedParagraph, to: emptyLinkedParagraph });
    ranges.sort((a, b) => a.from - b.from);

    function measure() {
      if (!surface || !editor || editor.isDestroyed) return;
      const origin = surface.getBoundingClientRect().top;
      const next: typeof marginBars = [];
      for (const { from, to } of ranges) {
        if (to > editor.state.doc.content.size) continue;
        const top = editor.view.coordsAtPos(from, 1).top - origin;
        const bottom = editor.view.coordsAtPos(to, from === to ? 1 : -1).bottom - origin;
        if (bottom <= top) continue;
        const previous = next[next.length - 1];
        if (previous && previous.bottom >= top) previous.bottom = Math.max(previous.bottom, bottom);
        else next.push({ top, bottom });
      }
      setMarginBars(next);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    const frame = requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [editor, entries, visible, props.typographyKey, emptyLinkedParagraph]);

  const matches = useMemo(() => {
    const results: Range[] = [];
    if (!editor || !search || !query.trim()) return results;
    const pattern = new RegExp(escapePattern(query.trim()), "giu");
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const text = node.textBetween(0, node.content.size, "", "\n");
      for (const match of text.matchAll(pattern)) {
        const from = pos + 1 + match.index;
        results.push({ from, to: from + match[0].length });
      }
      return false;
    });
    return results;
  }, [editor, contentJson, query, search]);

  function showMatch(index: number, finish = false) {
    if (!editor || !matches.length) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    if (finish) {
      setSearch(false);
      focus();
    }
    setSelection(editor, matches[next]!, true);
  }

  const selectedLink = useMemo(() => entries.find((entry) =>
    selection.from === selection.to
      ? entry.from <= selection.from && selection.from < entry.to
      : entry.from < selection.to && selection.from < entry.to),
  [entries, selection.from, selection.to]);
  const tracked = typingParagraph.current;
  const typingInLinkedParagraph = tracked && editor && selection.from === selection.to &&
    manuscriptParagraphAt(editor.state.doc, selection.from)?.from === tracked.from &&
    (!tracked.passageId || entries.some((entry) => entry.id === tracked.passageId &&
      entry.targetCardIds[0] === tracked.cardId));
  const linkedCard = active && visible && !props.choosingCard
    ? selectedLink?.targetCardIds[0] ?? (typingInLinkedParagraph ? tracked.cardId : null)
    : null;
  useLayoutEffect(() => {
    latest.current.onLinkedCardChange(linkedCard);
  }, [linkedCard]);
  const canLink = Boolean(!readOnly && visible && active && snapshot.cards.length && prose && editor && !props.choosingCard && !search &&
    hasPassageText(editor.state.doc, selection.from, selection.to));
  useEffect(() => {
    latest.current.onLinkEligibilityChange(canLink);
  }, [canLink]);

  return (
    <section
      ref={paneRef}
      aria-label="Manuscript"
      className="fc-manuscript-pane"
      hidden={!visible}
      inert={props.choosingCard}
      onCompositionStart={(event) => { event.currentTarget.dataset.editorComposing = "true"; }}
      onCompositionEnd={(event) => { delete event.currentTarget.dataset.editorComposing; }}
      onFocusCapture={props.onActivate}
      onPointerDownCapture={props.onActivate}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing ||
          event.keyCode === 229 || editor?.view.composing) return;
        if (event.key === "Escape" && search) {
          setSearch(false);
          focus();
        } else if (event.key === "Escape" && editor && searchHighlightKey.getState(editor.state)) {
          const { head } = editor.state.selection;
          setSelection(editor, { from: head, to: head });
        } else {
          if (readOnly || !editor || !(event.target instanceof Node) || !editor.view.dom.contains(event.target)) return;
          const { selection, doc } = editor.state;
          const atStart = event.key === "ArrowLeft" && !event.shiftKey && !event.altKey &&
            !event.metaKey && !event.ctrlKey && selection instanceof TextSelection &&
            selection.eq(Selection.atStart(doc));
          if ((event.key !== "Escape" && !atStart) || !props.onNavigateDirectory()) return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {search && (
        <div className="fc-manuscript-panel" role="search" aria-label="Search manuscript">
          <input ref={searchInput} aria-label="Search manuscript" value={query}
            onChange={(event) => { setQuery(event.target.value); setMatchIndex(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") { event.preventDefault(); showMatch(matchIndex, !event.shiftKey); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                showMatch(matchIndex + (event.key === "ArrowUp" ? -1 : 1));
              }
            }} />
          <span role="status">{matches.length ? `${matchIndex + 1} of ${matches.length}` : "No matches"}</span>
          <button type="button" disabled={!matches.length} onClick={() => showMatch(matchIndex - 1)}>Previous</button>
          <button type="button" disabled={!matches.length} onClick={() => showMatch(matchIndex + 1)}>Next</button>
          <button type="button" disabled={!matches.length} onClick={() => showMatch(matchIndex, true)}>Select result</button>
        </div>
      )}
      <div className="fc-manuscript-writing" ref={writing}>
        {(entries.length > 0 || emptyLinkedParagraph !== null) && marginBars.map(({ top, bottom }) => (
          <span key={top} aria-hidden="true" className="fc-manuscript-link-bar"
            style={{ top, height: bottom - top }} />
        ))}
        <EditorContent editor={editor} />
      </div>
    </section>
  );
}
