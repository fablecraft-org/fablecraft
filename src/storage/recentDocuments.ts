import { invoke } from "@tauri-apps/api/core";
import { forgetRecentDocumentPath, readRecentDocumentPaths } from "./lastDocument";

export async function refreshRecentDocumentPaths(): Promise<string[]> {
  const paths = readRecentDocumentPaths();
  if (paths.length === 0) return [];

  const existing = new Set(await invoke<string[]>("existing_document_paths", { paths }));
  // Re-read on removal so a concurrent open, rename, or deletion is preserved.
  for (const path of paths) {
    if (!existing.has(path)) forgetRecentDocumentPath(path);
  }
  return readRecentDocumentPaths().filter((path) => existing.has(path));
}
