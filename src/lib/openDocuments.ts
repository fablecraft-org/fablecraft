import { invoke } from "@tauri-apps/api/core";

export const OPEN_DOCUMENTS_EVENT = "fablecraft://open-documents";

interface OpenDocumentsPayload {
  paths: string[];
}

export async function takePendingOpenDocumentPaths() {
  try {
    const payload = await invoke("take_pending_open_document_paths");

    return Array.isArray(payload)
      ? payload.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

export async function listenForNativeOpenDocuments(
  onOpen: (paths: string[]) => void,
) {
  try {
    const { listen } = await import("@tauri-apps/api/event");

    return await listen<OpenDocumentsPayload>(OPEN_DOCUMENTS_EVENT, (event) => {
      if (Array.isArray(event.payload.paths)) {
        onOpen(event.payload.paths);
      }
    });
  } catch {
    return () => {};
  }
}
