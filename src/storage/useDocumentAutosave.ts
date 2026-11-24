import { useEffect } from "react";
import { useDocumentStore } from "../state/documentStore";
import { savePendingDocument } from "./forceSave";

export function useDocumentAutosave() {
  const dirty = useDocumentStore((state) => state.dirty);
  const snapshot = useDocumentStore((state) => state.snapshot);
  const conflict = useDocumentStore((state) => state.revisionConflict);

  useEffect(() => {
    if (!snapshot || !dirty || conflict) return;
    const timeoutId = window.setTimeout(() => {
      void savePendingDocument()?.catch(() => {});
    }, 450);
    return () => window.clearTimeout(timeoutId);
  }, [dirty, snapshot, conflict]);
}
