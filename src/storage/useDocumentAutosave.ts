import { useEffect } from "react";
import { toEditableDocumentSnapshot } from "../domain/document/serialization";
import { saveDocumentSnapshotAtPath } from "./documentSnapshots";
import { useDocumentStore } from "../state/documentStore";

export function useDocumentAutosave() {
  const dirty = useDocumentStore((state) => state.dirty);
  const snapshot = useDocumentStore((state) => state.snapshot);
  const markSaveError = useDocumentStore((state) => state.markSaveError);
  const markSaved = useDocumentStore((state) => state.markSaved);
  const markSaving = useDocumentStore((state) => state.markSaving);

  useEffect(() => {
    if (!snapshot || !dirty) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        markSaving();
        const result = await saveDocumentSnapshotAtPath(
          snapshot.summary.path,
          toEditableDocumentSnapshot(snapshot),
        );
        if (!cancelled) markSaved(result, snapshot.summary.documentId);
      } catch (error) {
        if (cancelled) return;
        markSaveError(
          error instanceof Error ? error.message : "Autosave failed unexpectedly.",
        );
      }
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [dirty, markSaveError, markSaved, markSaving, snapshot]);
}
