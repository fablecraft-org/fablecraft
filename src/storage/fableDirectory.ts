import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { DocumentSummary, FablecraftError } from "../types/document";

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

const documentSummarySchema = z.object({
  documentId: z.string().min(1),
  name: z.string().min(1),
  openedAtMs: z.number().int().nonnegative(),
  path: z.string().min(1),
});

function normalizeError(error: unknown): FablecraftError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    const maybeError = error as Partial<FablecraftError>;

    return {
      code: maybeError.code ?? "unknown_error",
      message: maybeError.message ?? "Unknown error",
      details: maybeError.details ?? null,
    };
  }

  return {
    code: "unknown_error",
    message: error instanceof Error ? error.message : "Unknown error",
    details: null,
  };
}

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
    return documentSummarySchema.parse(payload);
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
    return documentSummarySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}
