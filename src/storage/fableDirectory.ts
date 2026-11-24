import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { DocumentSummary } from "../types/document";
import { documentIdentitySchema, normalizeError } from "./documentResponse";

const fableDirectoryEntrySchema = z.object({
  kind: z.enum(["folder", "document"]),
  name: z.string().min(1),
  path: z.string().min(1),
});

export type FableDirectoryEntry = z.infer<typeof fableDirectoryEntrySchema>;

const fableDirectorySchema = z.object({
  currentDocumentPath: z.string().min(1),
  entries: z.array(fableDirectoryEntrySchema),
  folderName: z.string().min(1),
  folderPath: z.string().min(1),
  parentFolderPath: z.string().min(1).nullable(),
});

export type FableDirectory = z.infer<typeof fableDirectorySchema>;

export async function listCurrentDocumentDirectory() {
  try {
    const payload = await invoke("list_current_document_directory");
    return fableDirectorySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function listFableDirectory(path: string) {
  try {
    const payload = await invoke("list_fable_directory", { path });
    return fableDirectorySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function createUntitledDocumentInDirectory(path: string): Promise<DocumentSummary> {
  try {
    const payload = await invoke("create_untitled_document_in_directory", { path });
    return documentIdentitySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function deleteFableDocument(path: string) {
  try {
    await invoke("delete_fable_document", { path });
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function renameFableDocument(path: string, name: string): Promise<DocumentSummary> {
  try {
    const payload = await invoke("rename_fable_document", { path, name });
    return documentIdentitySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}
