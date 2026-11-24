import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { historyTime } from "../domain/document/historyTime";
import { paneShortcut, type WorkspacePane } from "../domain/document/manuscriptLayout";
import { latestRevisionId, normalizeDocumentSnapshot } from "../domain/document/serialization";
import type { DocumentSnapshot } from "../domain/document/types";
import { useDocumentStore } from "../state/documentStore";
import { useInteractionStore } from "../state/interactionStore";
import {
  compareDocumentHistory, historyPageSize, listDocumentHistory, loadHistoricalSnapshot, restoreHistoricalSnapshot,
  type HistoryChange, type HistoryComparison, type HistoryEntry, type HistoryFirstPage, type HistoryPage,
} from "../storage/documentHistory";
import { loadCurrentDocumentSnapshot } from "../storage/documentSnapshots";
import { forceSaveCurrentDocument } from "../storage/forceSave";
import type { DocumentSummary } from "../types/document";
import { DocumentWorkspace, type HistoryEditTarget, type WorkspaceViewMode } from "./DocumentWorkspace";
import { cardProse, manuscriptSchema } from "../domain/document/manuscriptMarkdown";
import { createCardSubtreeCopyPayload, encodeCardClipboardPayload } from "../domain/document/clipboard";
import { writeSubtreeToClipboard } from "../storage/historyClipboard";
import { OverlayShell } from "./OverlayShell";

const HISTORY_POLL_MS = 1500;
const HISTORY_PREPARING_POLL_MS = 250;
const HISTORY_PREFETCH_AFTER_ROWS = 10;
const TIME_REFRESH_MS = 1000;
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const creationTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

interface DocumentHistoryProps {
  document: DocumentSummary;
  firstPage?: HistoryFirstPage;
  current: DocumentSnapshot;
  session: number;
  pane: WorkspacePane;
  treeViewMode?: WorkspaceViewMode;
  narrow: boolean;
  surfaceVisible: boolean;
  onPane: (pane: WorkspacePane) => void;
  onSurfaceVisible: (visible: boolean) => void;
  shortcutsSuspended: boolean;
  onClose: () => void;
  onRestore: (target: HistoryEditTarget) => void;
}

function validatePreview(snapshot: DocumentSnapshot) {
  for (const content of snapshot.contents) cardProse(content.contentJson, manuscriptSchema);
  if (snapshot.manuscript) manuscriptSchema.nodeFromJSON(JSON.parse(snapshot.manuscript.contentJson)).check();
}

type PreviewFocus = Pick<HistoryChange, "cardId" | "passage" | "cardRange"> & { request: number };

function comparisonMessage(comparison: HistoryComparison | undefined) {
  if (!comparison) return "Comparing snapshots…";
  if (comparison.status === "initial") return "Earliest retained snapshot";
  if (comparison.status === "unavailable") return "Changes unavailable";
  return "No document changes";
}

function SnapshotChangeSummary({ comparison }: { comparison: HistoryComparison | undefined }) {
  if (comparison?.status !== "compared" || !comparison.changes.length) {
    return <span className="fc-history-muted">{comparisonMessage(comparison)}</span>;
  }

  const cards = new Map<string, { label: string; tone: string; descriptions: string[]; added: number; removed: number }>();
  let added = 0;
  let removed = 0;
  for (const change of comparison.changes) {
    added += change.characters?.added ?? 0;
    removed += change.characters?.removed ?? 0;
    if (!change.card) continue;
    const { id, label } = change.card;
    const cardAdded = change.characters?.added ?? 0;
    const cardRemoved = change.characters?.removed ?? 0;
    const existing = cards.get(id);
    if (existing) {
      existing.descriptions.push(change.description);
      existing.added += cardAdded;
      existing.removed += cardRemoved;
    } else {
      const tone = change.kind === "cardAdded" ? "added" : change.kind === "cardDeleted" ? "removed" : "modified";
      cards.set(id, { label, tone, descriptions: [change.description], added: cardAdded, removed: cardRemoved });
    }
  }

  return (
    <>
      {cards.size > 0 && (
        <span className="fc-history-card-symbols">
          {[...cards].map(([id, { label, tone, descriptions, added, removed }]) => (
            <span key={id} className="fc-history-card-symbol" data-change={tone}
              role="img" aria-label={descriptions.join(". ")}
              title={descriptions.join(". ") + (added || removed ? ` · +${added} / −${removed} characters` : "")}>
              {label}
            </span>
          ))}
        </span>
      )}
      <span className="fc-history-character-total">
        <span data-change="added"><span aria-hidden="true">+{added}</span><span className="sr-only">{added} characters added</span></span>
        <span data-change="removed"><span aria-hidden="true">−{removed}</span><span className="sr-only">{removed} characters removed</span></span>
      </span>
    </>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : fallback;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : null;
}

function comparableHistoryContent(snapshot: DocumentSnapshot) {
  // Rust and the editors can serialize the same rich document with different key order.
  const decoded = (contentJson: string) => {
    try { return JSON.parse(contentJson) as unknown; } catch { return contentJson; }
  };
  const { cards, contents, manuscript } = snapshot;
  return JSON.stringify({
    cards,
    contents: contents.map(({ cardId, contentJson }) => ({ cardId, prose: decoded(contentJson) })),
    manuscript: manuscript && { ...manuscript, contentJson: decoded(manuscript.contentJson) },
  }, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
    }
    return value;
  });
}

export function DocumentHistory({
  document, firstPage, current, session, pane, treeViewMode = "normal", narrow, surfaceVisible, shortcutsSuspended, onPane, onSurfaceVisible, onClose, onRestore,
}: DocumentHistoryProps) {
  const [now, setNow] = useState(Date.now);
  const [page, setPage] = useState<HistoryPage | null>(() => firstPage?.page ?? null);
  const [checkedFirstPage, setCheckedFirstPage] = useState(false);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [preview, setPreview] = useState<DocumentSnapshot | null>(null);
  const [previewChanges, setPreviewChanges] = useState<HistoryChange[]>([]);
  const [comparisons, setComparisons] = useState<Record<string, HistoryComparison>>(() => page?.comparisons ?? {});
  const [previewCard, setPreviewCard] = useState<string | null>(null);
  const [focus, setFocus] = useState<PreviewFocus>({ request: 0 });
  const [unavailable, setUnavailable] = useState(false);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState("");
  const [listError, setListError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [confirmation, setConfirmation] = useState<{ head: string | null; target: HistoryEditTarget } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const timeline = useRef<HTMLElement>(null);
  const confirmDialog = useRef<HTMLDivElement>(null);
  const timelineFocusPending = useRef(false);
  const nextNavigationRequest = useRef(0);
  const [navigationRequest, setNavigationRequest] = useState<number>();
  const previewRegion = useRef<HTMLElement>(null);
  const selectedRef = useRef<HistoryEntry | null>(null);
  const pageRef = useRef(page);
  const comparisonCache = useRef(comparisons);
  const picking = useRef(0);
  const listing = useRef(false);
  const selectAfterPage = useRef(false);
  const mounted = useRef(false);
  const head = latestRevisionId(current);
  const created = new Date(current.summary.createdAtMs ?? document.createdAtMs ?? NaN);
  const createdDateTime = created.toJSON();
  const matchesCurrent = useMemo(() => Boolean(preview &&
    (selected?.id === head || comparableHistoryContent(preview) === comparableHistoryContent(current))),
  [current, head, preview, selected]);
  const canRestore = Boolean(preview && selected && !expired && page?.headId === head && !matchesCurrent);

  function stillOpen() {
    return mounted.current && useDocumentStore.getState().session === session;
  }

  function updateList(next: HistoryPage, requestedSelection: string | null) {
    const currentBaseline = next.headId && next.entries.find(({ id }) => id !== next.headId);
    if (currentBaseline && next.headId) {
      next = { ...next, previousVisible: { ...next.previousVisible, [next.headId]: currentBaseline.id } };
    }
    const previous = pageRef.current;
    if (previous && previous.maintenanceAtMs !== next.maintenanceAtMs) {
      comparisonCache.current = {};
    } else if (previous) {
      comparisonCache.current = Object.fromEntries(Object.entries(comparisonCache.current)
        .filter(([id]) => previous.previousVisible[id] === next.previousVisible[id]));
    }
    comparisonCache.current = { ...comparisonCache.current, ...next.comparisons };
    setComparisons(comparisonCache.current);
    pageRef.current = next;
    setPage(next);
    setListError("");
    if (!next.selectedRetained && selectedRef.current?.id === requestedSelection) setExpired(true);
  }

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timeout: number | undefined;

    async function refresh() {
      if (!listing.current) {
        listing.current = true;
        try {
          const requestedSelection = selectedRef.current?.id ?? null;
          const previous = pageRef.current;
          const pending = requestedSelection === null ? firstPage?.pending : null;
          const first = await (pending ?? listDocumentHistory(document, null, requestedSelection,
            previous && !previous.preparing ? { headId: previous.headId, maintenanceAtMs: previous.maintenanceAtMs } : undefined));
          if (stopped || !stillOpen()) return;
          if (!first.selectedRetained && selectedRef.current?.id === requestedSelection) setExpired(true);
          if (!previous || first.headId !== previous.headId || first.maintenanceAtMs !== previous.maintenanceAtMs ||
            (previous.preparing && !first.preparing)) {
            if (firstPage && !first.preparing) firstPage.page = first;
            updateList(first, requestedSelection);
          }
        } catch (error) {
          if (!stopped && stillOpen() && !pageRef.current) {
            setListError(errorMessage(error, "Could not load History."));
          }
        } finally {
          listing.current = false;
          if (!stopped) setCheckedFirstPage(true);
        }
      }
      if (!stopped) timeout = window.setTimeout(() => void refresh(),
        pageRef.current?.preparing ? HISTORY_PREPARING_POLL_MS : HISTORY_POLL_MS);
    }

    timeline.current?.querySelector<HTMLElement>("[aria-current=true]")?.focus({ preventScroll: true });
    void refresh();
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timeout);
    };
  }, [document.path, document.documentId, session, firstPage]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!page) return;
    let stopped = false;
    const revisions = page.entries.filter(({ id }) => id !== page.headId).map(({ id }) => id);
    if (page.headId && page.previousVisible[page.headId]) revisions.unshift(page.headId);
    const ids = revisions.filter((id) => !comparisonCache.current[id]);
    async function loadComparisons() {
      for (let index = 0; index < ids.length; index += historyPageSize) {
        const batch = ids.slice(index, index + historyPageSize);
        let deltas: Record<string, HistoryComparison>;
        try {
          deltas = await compareDocumentHistory(document, batch, page?.previousVisible);
        } catch {
          deltas = Object.fromEntries(batch.map((id) => [id, { status: "unavailable" }]));
        }
        if (stopped || !stillOpen() || pageRef.current !== page) return;
        comparisonCache.current = { ...comparisonCache.current, ...deltas };
        setComparisons(comparisonCache.current);
      }
    }
    void loadComparisons();
    return () => { stopped = true; };
  }, [page, document.path, document.documentId]);

  useEffect(() => {
    if (confirmation) confirmDialog.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [Boolean(confirmation)]);

  useLayoutEffect(() => {
    if (!surfaceVisible && timelineFocusPending.current) {
      timelineFocusPending.current = false;
      timeline.current?.querySelector<HTMLElement>("[aria-current=true]")?.focus({ preventScroll: true });
    }
  }, [surfaceVisible, selected?.id]);

  useLayoutEffect(() => {
    if (surfaceVisible && navigationRequest !== undefined && (!preview || (pane === "manuscript" && !preview.manuscript))) {
      previewRegion.current?.focus({ preventScroll: true });
    }
  }, [surfaceVisible, navigationRequest, preview, pane]);

  async function loadOlder(selectNext = false) {
    const previous = pageRef.current;
    if (listing.current) {
      if (selectNext && loadingOlder) selectAfterPage.current = true;
      return;
    }
    if (!previous?.hasMore || !previous.entries.length) return;
    listing.current = true;
    setLoadingOlder(true);
    const requestedSelection = selectedRef.current?.id ?? null;
    try {
      const next = await listDocumentHistory(document, previous.entries[previous.entries.length - 1]!, requestedSelection);
      if (!stillOpen() ||
        next.headId !== previous.headId || next.maintenanceAtMs !== previous.maintenanceAtMs) return;
      updateList({
        ...next,
        headId: previous.headId,
        maintenanceAtMs: previous.maintenanceAtMs,
        entries: previous.entries.concat(next.entries),
        previousVisible: { ...previous.previousVisible, ...next.previousVisible },
      }, requestedSelection);
      if ((selectNext || selectAfterPage.current) && selectedRef.current?.id === requestedSelection && next.entries[0] &&
        timeline.current?.contains(window.document.activeElement)) {
        timelineFocusPending.current = true;
        void choose(next.entries[0], false);
      }
    } catch (error) {
      if (stillOpen()) setListError(errorMessage(error, "Could not load older snapshots."));
    } finally {
      listing.current = false;
      selectAfterPage.current = false;
      if (stillOpen()) setLoadingOlder(false);
    }
  }

  useEffect(() => {
    if (!checkedFirstPage || !page?.hasMore || page.entries.length !== HISTORY_PREFETCH_AFTER_ROWS) return;
    const timer = window.setTimeout(() => void loadOlder(), 0);
    return () => window.clearTimeout(timer);
  }, [page, checkedFirstPage]);

  function enterPreview() {
    setNavigationRequest(++nextNavigationRequest.current);
    onSurfaceVisible(true);
  }

  async function choose(entry: HistoryEntry | null, showSurface: boolean) {
    if (useDocumentStore.getState().restoringHistory) return;
    if (entry && entry.id === selectedRef.current?.id) {
      if (showSurface) enterPreview();
      return;
    }
    const request = ++picking.current;
    selectedRef.current = entry;
    setSelected(entry);
    setPreview(null);
    setPreviewChanges([]);
    setPreviewCard(null);
    setUnavailable(false);
    setExpired(false);
    setNotice("");
    setConfirmation(null);
    useDocumentStore.getState().setHistoricalPreview(Boolean(entry));
    if (showSurface && entry) enterPreview();
    else if (showSurface) onSurfaceVisible(true);
    if (!entry) return;

    try {
      await forceSaveCurrentDocument();
    } catch (error) {
      if (stillOpen() && picking.current === request) {
        void choose(null, true);
        setNotice(errorMessage(error, "Could not save pending edits."));
      }
      return;
    }
    if (!stillOpen() || picking.current !== request) return;

    try {
      const [historical, comparison] = await Promise.all([
        loadHistoricalSnapshot(document, entry.id),
        Promise.resolve(comparisonCache.current[entry.id] ?? compareDocumentHistory(document, [entry.id], pageRef.current?.previousVisible)
          .then((deltas) => deltas[entry.id]).catch(() => undefined)),
      ]);
      if (!stillOpen() || picking.current !== request) return;
      const snapshot = normalizeDocumentSnapshot({ ...historical, summary: document, revisions: [] });
      validatePreview(snapshot);
      const changes = comparison?.status === "compared" ? comparison.changes : [];
      setPreviewChanges(changes);
      const treeChange = changes.find(({ kind, addedRanges }) => kind !== "manuscript" && addedRanges?.length)
        ?? changes.find(({ kind }) => kind !== "manuscript");
      const manuscriptChange = changes.find(({ kind }) => kind === "manuscript");
      if (treeChange && !manuscriptChange) onPane("tree");
      else if (manuscriptChange && !treeChange) onPane("manuscript");
      const activeCardId = useInteractionStore.getState().activeCardId;
      setFocus((previous) => ({
        cardId: treeChange?.cardId ?? (snapshot.cards.some(({ id }) => id === activeCardId) ? activeCardId! : undefined),
        cardRange: treeChange?.addedRanges?.[0] ?? treeChange?.cardRange,
        passage: manuscriptChange?.addedRanges?.[0] ?? manuscriptChange?.passage,
        request: previous.request + 1,
      }));
      setPreview(snapshot);
    } catch (error) {
      if (!stillOpen() || picking.current !== request) return;
      if (errorCode(error) === "history_revision_expired") setExpired(true);
      setUnavailable(true);
    }
  }

  function cancelConfirmation() {
    if (useDocumentStore.getState().restoringHistory) return;
    setConfirmation(null);
    setComparisonError("");
    enterPreview();
  }

  async function restore() {
    if (!selected || !confirmation || !canRestore || useDocumentStore.getState().restoringHistory) return;
    const state = useDocumentStore.getState();
    if (!state.snapshot || state.session !== session || state.dirty || latestRevisionId(state.snapshot) !== head) return;
    state.setRestoringHistory(true);
    setRestoring(true);
    setComparisonError("");
    try {
      const restored = await restoreHistoricalSnapshot(document, selected.id, head);
      if (!stillOpen()) return;
      useDocumentStore.getState().installRestoredSnapshot(restored, session);
      onRestore(confirmation.target);
    } catch (error) {
      if (!stillOpen()) return;
      if (errorCode(error) === "history_revision_expired") {
        setExpired(true);
        setConfirmation(null);
        enterPreview();
      } else if (errorCode(error) === "stale_document_revision") {
        setComparisonError("Current changed. Review the latest save before restoring.");
        try {
          const latest = await loadCurrentDocumentSnapshot();
          if (stillOpen() && latest.summary.documentId === document.documentId && latest.summary.path === document.path) {
            useDocumentStore.getState().commitExternalSnapshot(latest, state.snapshot);
          }
        } catch (reloadError) {
          if (stillOpen()) setComparisonError(errorMessage(reloadError, "Could not refresh Current."));
        }
      } else {
        setComparisonError(errorMessage(error, "Could not restore the snapshot."));
      }
    } finally {
      if (useDocumentStore.getState().session === session) useDocumentStore.getState().setRestoringHistory(false);
      if (stillOpen()) setRestoring(false);
    }
  }

  function back() {
    timelineFocusPending.current = true;
    setNavigationRequest(undefined);
    onSurfaceVisible(false);
  }

  function markPreviewFocused() {
    if (!surfaceVisible) onSurfaceVisible(true);
  }

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (shortcutsSuspended || event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape" && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (confirmation) cancelConfirmation();
        else if (surfaceVisible) back();
        else onClose();
        return;
      }
      if (confirmation && event.key === "Tab") {
        event.preventDefault();
        const buttons = [...(confirmDialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
        return;
      }
      if (confirmation && event.key === "Enter" && event.repeat) {
        event.preventDefault();
        return;
      }
      if (paneShortcut(event, /Mac|iPhone|iPad/.test(navigator.platform)) !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!confirmation) onPane(event.key === "ArrowLeft" ? "tree" : "manuscript");
      }
    }
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  });

  async function copySubtree() {
    if (!preview || !previewCard) return;
    try {
      await writeSubtreeToClipboard(encodeCardClipboardPayload(createCardSubtreeCopyPayload(preview, previewCard)));
      if (stillOpen()) setNotice("Copied card subtree.");
    } catch {
      if (stillOpen()) setNotice("Could not copy the card subtree.");
    }
  }

  function handlePreviewKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (shortcutsSuspended || event.nativeEvent.isComposing || event.defaultPrevented ||
      !(event.target instanceof Element) || event.target.closest("button, a, [role=link]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && pane === "tree" &&
      window.getSelection()?.isCollapsed !== false && previewCard) {
      event.preventDefault();
      void copySubtree();
      return;
    }
    if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (event.repeat || confirmation || !preview || expired || (pane === "tree" && !previewCard)) return;
    if (matchesCurrent) {
      setNotice("This snapshot already matches Current.");
      return;
    }
    setConfirmation({ head, target: { pane, cardId: pane === "tree" ? previewCard ?? undefined : undefined } });
  }

  const entries = page?.entries.filter(({ id }) => id !== page.headId) ?? [];
  const timelineEntries = selected && !entries.some((entry) => entry.id === selected.id)
    ? [...entries, selected].sort((a, b) => b.createdAtMs - a.createdAtMs || b.sequence - a.sequence)
    : entries;
  function browseTimeline(event: ReactKeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && event.target instanceof Element && event.target.closest("[data-history-entry]")) {
      event.preventDefault();
      if (!event.repeat) {
        const target = event.target.closest("[data-history-entry]");
        const index = [...timeline.current!.querySelectorAll("[data-history-entry]")].indexOf(target!);
        void choose(timelineEntries[index - 1] ?? null, true);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = selected ? timelineEntries.findIndex((entry) => entry.id === selected.id) + 1 : 0;
    if (event.key === "ArrowDown" && index === timelineEntries.length && page?.hasMore) {
      void loadOlder(true);
      return;
    }
    const target = Math.max(0, Math.min(timelineEntries.length, index + (event.key === "ArrowDown" ? 1 : -1)));
    void choose(timelineEntries[target - 1] ?? null, false);
    timeline.current?.querySelectorAll<HTMLElement>("[data-history-entry]")[target]?.focus({ preventScroll: true });
  }

  return <>
    <aside className="fc-history-timeline" data-pane={pane} aria-label="Document history" ref={timeline}
      hidden={narrow && surfaceVisible} inert={Boolean(confirmation)} onKeyDown={browseTimeline}
      onFocusCapture={() => {
        if (!surfaceVisible) return;
        setNavigationRequest(undefined);
        onSurfaceVisible(false);
      }}>
      <div className="fc-history-toolbar">
        <h2>History</h2>
        <button type="button" className="fc-history-close" aria-label="Close History" title="Close History"
          onClick={() => onClose()}>×</button>
      </div>
      <div className="fc-history-entries" onFocusCapture={(event) => {
        const list = event.currentTarget;
        const row = event.target.getBoundingClientRect();
        const top = list.getBoundingClientRect().top + list.clientTop;
        const bottom = top + list.clientHeight;
        if (row.top < top || row.height > list.clientHeight) list.scrollTop += row.top - top;
        else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
      }}>
        <button type="button" className="fc-history-row" data-history-entry aria-current={!selected}
          onClick={() => void choose(null, true)}>
          <span>Current</span>
          {head && head === page?.headId && page.previousVisible[head] &&
            <SnapshotChangeSummary comparison={comparisons[head]} />}
        </button>
        {timelineEntries.map((entry) => (
          <button type="button" className="fc-history-row" key={entry.id} data-history-entry
              aria-current={selected?.id === entry.id} onClick={(event) => {
              if (!narrow) event.currentTarget.focus({ preventScroll: true });
              void choose(entry, narrow);
            }}>
            <time dateTime={new Date(entry.createdAtMs).toJSON() ?? undefined} title={new Date(entry.createdAtMs).toJSON() ? timestamp.format(entry.createdAtMs) : undefined}>
              {historyTime(entry.createdAtMs, now)}
            </time>
            <SnapshotChangeSummary comparison={comparisons[entry.id]} />
            {expired && selected?.id === entry.id && <span className="fc-history-muted">Expired</span>}
          </button>
        ))}
        {!page && !listError && <p role="status" className="fc-history-muted">Loading History…</p>}
        {page?.preparing && !entries.length && !listError && <p role="status" className="fc-history-muted">Preparing History…</p>}
        {page && !page.preparing && !entries.length && <p className="fc-history-muted">There are no earlier snapshots to browse.</p>}
        {page?.hasMore && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? "Loading…" : "Load Older Snapshots"}
        </button>}
        {page && !page.preparing && !page.hasMore && createdDateTime && (
          <p className="fc-history-created fc-history-muted">
            Document created <time dateTime={createdDateTime}>{creationTimestamp.format(created)}</time>
          </p>
        )}
        {listError && <p role="alert">{listError}</p>}
        {!selected && notice && <p role="alert">{notice}</p>}
      </div>
    </aside>
    {selected && (
      <section className="fc-history-preview" ref={previewRegion} tabIndex={-1} aria-label="Historical preview"
        hidden={narrow && !surfaceVisible} inert={Boolean(confirmation)}
        onKeyDownCapture={handlePreviewKey} onFocusCapture={markPreviewFocused} onPointerDownCapture={markPreviewFocused}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}>
        {narrow && <div className="fc-history-current-bar"><button type="button" onClick={back}>Back</button></div>}
        {expired && <p role="status">{preview ? "This snapshot expired. You can still copy its content." : "This snapshot is no longer retained."}</p>}
        {notice && <p role="status">{notice}</p>}
        {unavailable && <p role="alert">This snapshot is unavailable.</p>}
        {!preview && !unavailable && <p role="status" className="fc-history-muted">Loading snapshot…</p>}
        {preview && <div className="fc-history-live-surface">
          <DocumentWorkspace key={selected.id} document={document} historyPreview={{
            snapshot: preview, pane, focus, changes: previewChanges, onPane, onCard: setPreviewCard, initialViewMode: treeViewMode, navigationRequest,
          }} />
        </div>}
      </section>
    )}
    {selected && confirmation && (
      <OverlayShell onBackdropMouseDown={cancelConfirmation}>
        <div ref={confirmDialog} className="fc-history-confirm" role="alertdialog" aria-modal="true"
          aria-labelledby="fc-restore-heading" aria-describedby="fc-restore-description">
          <h2 id="fc-restore-heading">Restore Snapshot</h2>
          <p id="fc-restore-description">
            Restore the entire document to {timestamp.format(selected.createdAtMs)} and start editing? This creates a new latest snapshot and keeps the intervening saves.
          </p>
          <p>{current.revisions[0] ? `Current was saved at ${timestamp.format(current.revisions[0].createdAtMs)}.` : "Current has no saved revision."}</p>
          {confirmation.head !== head && <p role="status">Current changed since you opened this confirmation.</p>}
          {page?.headId !== head && <p role="status">Refreshing Current…</p>}
          {expired && <p role="status">This snapshot is no longer retained.</p>}
          {comparisonError && <p role="alert">{comparisonError}</p>}
          <div className="fc-history-toolbar">
            <button type="button" onClick={cancelConfirmation} disabled={restoring}>Cancel</button>
            <button type="button" onClick={() => void restore()} disabled={!canRestore || restoring}>
              {restoring ? "Restoring…" : "Restore"}
            </button>
          </div>
        </div>
      </OverlayShell>
    )}
  </>;
}
