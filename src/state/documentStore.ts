import { create } from "zustand";
import type { HistoryMode } from "../domain/document/history";
import {
  normalizeDocumentSnapshot,
  serializeComparableDocumentSnapshot,
} from "../domain/document/serialization";
import type { DocumentSnapshot, SaveDocumentResult } from "../domain/document/types";
import type { DocumentSummary } from "../types/document";

type SaveState = "idle" | "saving" | "saved" | "error";
type Update = (snapshot: DocumentSnapshot) => DocumentSnapshot;

interface DocumentState {
  clearDocument: () => void;
  applyNavigationChange: (updater: Update) => void;
  editingFuture: DocumentSnapshot[];
  editingPast: DocumentSnapshot[];
  commitExternalSnapshot: (snapshot: DocumentSnapshot, expected?: DocumentSnapshot) => void;
  dirty: boolean;
  historicalPreview: boolean;
  restoringHistory: boolean;
  setRestoringHistory: (active: boolean) => void;
  setHistoricalPreview: (active: boolean) => void;
  installRestoredSnapshot: (snapshot: DocumentSnapshot, session: number) => void;
  errorMessage: string | null;
  revisionConflict: boolean;
  session: number;
  hydrateSnapshot: (snapshot: DocumentSnapshot) => void;
  lastSavedAtMs: number | null;
  markSaveError: (message: string, conflict?: boolean) => void;
  markSaved: (result: SaveDocumentResult, documentId?: string, savedSnapshot?: DocumentSnapshot) => void;
  markSaving: () => void;
  navigationFuture: DocumentSnapshot[];
  navigationPast: DocumentSnapshot[];
  chronologicalPast: DocumentSnapshot[];
  chronologicalFuture: DocumentSnapshot[];
  sharedHistory: boolean;
  redoEditing: () => void;
  redoNavigation: () => void;
  saveState: SaveState;
  snapshot: DocumentSnapshot | null;
  updateSnapshot: (updater: Update) => void;
  updateSummary: (summary: DocumentSummary) => void;
  undoEditing: () => void;
  undoNavigation: () => void;
}

const emptyHistory = () => ({
  editingPast: [],
  editingFuture: [],
  navigationPast: [],
  navigationFuture: [],
  chronologicalPast: [],
  chronologicalFuture: [],
  sharedHistory: false,
});

function sameContent(left: DocumentSnapshot, right: DocumentSnapshot) {
  return left === right || (
    left.cards === right.cards && left.contents === right.contents && left.summary === right.summary
      ? left.manuscript === right.manuscript
      : serializeComparableDocumentSnapshot(left) === serializeComparableDocumentSnapshot(right)
  );
}

function record(state: DocumentState, current: DocumentSnapshot, next: DocumentSnapshot, mode: HistoryMode) {
  if (sameContent(current, next)) return {};
  return {
    [`${mode}Past`]: [...state[`${mode}Past`], current],
    [`${mode}Future`]: [],
    chronologicalPast: [...state.chronologicalPast, current],
    chronologicalFuture: [],
    sharedHistory: state.sharedHistory || Boolean(current.manuscript || next.manuscript),
  };
}

function latestSavedAt(snapshot: DocumentSnapshot) {
  return snapshot.revisions.reduce<number | null>((latest, revision) =>
    Math.max(latest ?? 0, revision.createdAtMs), null);
}

export const useDocumentStore = create<DocumentState>((set) => {
  function change(updater: Update, mode: HistoryMode) {
    set((state) => {
      const current = state.snapshot;
      if (!current || state.historicalPreview) return state;
      const candidate = updater(current);
      if (candidate === current) return state;
      const next = candidate.cards === current.cards && candidate.contents === current.contents
        ? candidate
        : normalizeDocumentSnapshot(candidate);
      const history = record(state, current, next, mode);
      if (!history.chronologicalPast) return state;

      return {
        ...history,
        snapshot: next,
        dirty: true,
        errorMessage: state.revisionConflict ? state.errorMessage : null,
        saveState: state.revisionConflict ? "error" : "idle",
      };
    });
  }

  function navigateHistory(mode: HistoryMode, direction: "undo" | "redo") {
    set((state) => {
      if (!state.snapshot || state.historicalPreview) return state;
      const stack = state.sharedHistory ? "chronological" : mode;
      const past = state[`${stack}Past`];
      const future = state[`${stack}Future`];
      const next = direction === "undo" ? past[past.length - 1] : future[0];
      if (!next) return state;

      const nextPast = direction === "undo" ? past.slice(0, -1) : [...past, state.snapshot];
      const nextFuture = direction === "undo" ? [state.snapshot, ...future] : future.slice(1);
      return {
        [`${stack}Past`]: nextPast,
        [`${stack}Future`]: nextFuture,
        // History changes editable state while retaining the current disk base.
        snapshot: { ...next, summary: state.snapshot.summary, revisions: state.snapshot.revisions },
        dirty: true,
        ...(!state.sharedHistory ? {
          chronologicalPast: direction === "undo"
            ? state.chronologicalPast.filter((entry) => entry !== next)
            : [...state.chronologicalPast, state.snapshot],
        } : {}),
      };
    });
  }

  return {
    ...emptyHistory(),
    clearDocument: () => set((state) => ({
      ...emptyHistory(),
      snapshot: null,
      historicalPreview: false,
      restoringHistory: false,
      dirty: false,
      errorMessage: null,
      lastSavedAtMs: null,
      revisionConflict: false,
      saveState: "idle",
      session: state.session + 1,
    })),
    applyNavigationChange: (updater) => change(updater, "navigation"),
    updateSnapshot: (updater) => change(updater, "editing"),
    commitExternalSnapshot: (snapshot, expected) =>
      set((state) => {
        if (state.dirty || (expected && state.snapshot !== expected)) return state;
        const next = normalizeDocumentSnapshot(snapshot);
        return {
          ...(state.snapshot ? record(state, state.snapshot, next, "navigation") : emptyHistory()),
          dirty: false,
          errorMessage: null,
          lastSavedAtMs: latestSavedAt(next) ?? state.lastSavedAtMs,
          revisionConflict: false,
          saveState: "saved",
          snapshot: next,
        };
      }),
    historicalPreview: false,
    restoringHistory: false,
    setRestoringHistory: (restoringHistory) => set({ restoringHistory }),
    setHistoricalPreview: (historicalPreview) => set({ historicalPreview }),
    installRestoredSnapshot: (snapshot, session) =>
      set((state) => {
        if (state.session !== session || state.dirty || !state.snapshot) return state;
        const next = normalizeDocumentSnapshot(snapshot);
        if (state.snapshot.summary.documentId !== next.summary.documentId) return state;
        const history = record(state, state.snapshot, next, "navigation");
        return {
          ...history,
          sharedHistory: true,
          dirty: false,
          errorMessage: null,
          revisionConflict: false,
          lastSavedAtMs: latestSavedAt(next),
          saveState: "saved",
          snapshot: next,
        };
      }),
    dirty: false,
    errorMessage: null,
    hydrateSnapshot: (snapshot) =>
      set((state) => ({
        ...emptyHistory(),
        dirty: false,
        historicalPreview: false,
        restoringHistory: false,
        errorMessage: null,
        lastSavedAtMs: latestSavedAt(snapshot),
        revisionConflict: false,
        saveState: "idle",
        sharedHistory: Boolean(snapshot.manuscript),
        snapshot: normalizeDocumentSnapshot(snapshot),
        session: state.session + 1,
      })),
    lastSavedAtMs: null,
    revisionConflict: false,
    session: 0,
    markSaveError: (message, conflict = false) =>
      set({ errorMessage: message, revisionConflict: conflict, saveState: "error" }),
    markSaved: (result, documentId, savedSnapshot) =>
      set((state) => {
        const current = state.snapshot;
        if (!current || (documentId && current.summary.documentId !== documentId)) return state;
        const dirty = Boolean(savedSnapshot && !sameContent(savedSnapshot, current));

        return {
          dirty,
          errorMessage: null,
          lastSavedAtMs: result.savedAtMs,
          revisionConflict: false,
          saveState: dirty ? "idle" : "saved",
          snapshot: {
            ...current,
            revisions: [
              {
                createdAtMs: result.savedAtMs,
                id: result.revisionId,
              },
              ...current.revisions.filter((revision) => revision.id !== result.revisionId)
                .sort((a, b) => b.createdAtMs - a.createdAtMs),
            ].slice(0, 20),
            summary: {
              ...current.summary,
              fileModifiedAtMs: result.savedAtMs,
              updatedAtMs: result.savedAtMs,
            },
          },
        };
      }),
    markSaving: () => set({ saveState: "saving" }),
    redoEditing: () => navigateHistory("editing", "redo"),
    redoNavigation: () => navigateHistory("navigation", "redo"),
    undoEditing: () => navigateHistory("editing", "undo"),
    undoNavigation: () => navigateHistory("navigation", "undo"),
    saveState: "idle",
    snapshot: null,
    updateSummary: (summary) => set((state) => ({
      snapshot: state.snapshot
        ? { ...state.snapshot, summary: { ...state.snapshot.summary, ...summary } }
        : null,
    })),
  };
});
