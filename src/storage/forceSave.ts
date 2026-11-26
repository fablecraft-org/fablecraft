import { toEditableDocumentSnapshot } from "../domain/document/serialization";
import type { SaveDocumentResult } from "../domain/document/types";
import { useDocumentStore } from "../state/documentStore";
import { normalizeError } from "./documentResponse";
import { saveDocumentSnapshotAtPath } from "./documentSnapshots";

let inFlight: { session: number; result: Promise<SaveDocumentResult> } | null = null;

export function savePendingDocument() {
  const state = useDocumentStore.getState();
  if (inFlight?.session === state.session) return inFlight.result;
  const snapshot = state.snapshot;
  if (!snapshot || !state.dirty) return null;

  state.markSaving();
  const session = state.session;
  const result = (async () => {
    try {
      const saved = await saveDocumentSnapshotAtPath(snapshot.summary.path, toEditableDocumentSnapshot(snapshot));
      const current = useDocumentStore.getState();
      if (current.session === session) current.markSaved(saved, snapshot.summary.documentId, snapshot);
      return saved;
    } catch (error) {
      const current = useDocumentStore.getState();
      if (current.session === session) {
        const { code, message } = normalizeError(error);
        current.markSaveError(
          message === "Unknown error" ? "Autosave failed unexpectedly." : message,
          code === "stale_document_revision" || code === "unsupported_document_version",
        );
      }
      throw error;
    } finally {
      if (inFlight?.session === session) inFlight = null;
    }
  })();
  inFlight = { session, result };
  return result;
}

export async function forceSaveCurrentDocument() {
  const session = useDocumentStore.getState().session;
  let result: SaveDocumentResult | null = null;
  while (useDocumentStore.getState().session === session) {
    const pending = savePendingDocument();
    if (!pending) break;
    result = await pending;
  }
  return result;
}
