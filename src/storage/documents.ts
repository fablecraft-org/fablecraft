import { invoke } from "@tauri-apps/api/core";
import type { DocumentSummary } from "../types/document";
import { documentIdentitySchema, normalizeError } from "./documentResponse";

async function invokeDocumentCommand(
  command: "create_document" | "open_document",
  path: string,
): Promise<DocumentSummary> {
  try {
    const payload = await invoke(command, { path });
    return documentIdentitySchema.parse(payload);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function createDocumentAtPath(path: string) {
  return invokeDocumentCommand("create_document", path);
}

export function openDocumentAtPath(path: string) {
  return invokeDocumentCommand("open_document", path);
}
