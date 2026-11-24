import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { DocumentSnapshot, EditableDocumentSnapshot, SaveDocumentResult } from "../domain/document/types";
import type { DocumentClock } from "../types/document";
import { documentIdentitySchema, normalizeError } from "./documentResponse";

export { normalizeError } from "./documentResponse";

export const cardSchema = z.object({
  documentId: z.string().min(1),
  id: z.string().min(1),
  orderIndex: z.number().int().min(0),
  parentId: z.string().nullable(),
  type: z.literal("card"),
});

export const contentSchema = z.object({
  cardId: z.string().min(1),
  contentJson: z.string().min(1),
});

export const revisionSchema = z.object({
  createdAtMs: z.number().int().nonnegative(),
  id: z.string().min(1),
  sequence: z.number().int().optional(),
  snapshot: z.string().optional(),
});

export const documentSummarySchema = documentIdentitySchema.extend({
  fileModifiedAtMs: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
});

const documentClockSchema = z.object({
  documentId: z.string().min(1),
  fileModifiedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

const manuscriptSchema = z.object({
  id: z.string().uuid(),
  contentJson: z.string().min(1),
  passages: z.array(z.object({
    id: z.string().uuid(),
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    targetCardIds: z.array(z.string().min(1)),
  })),
});

export const snapshotSchema = z.object({
  cards: z.array(cardSchema),
  contents: z.array(contentSchema),
  manuscript: manuscriptSchema.nullish(),
  revisions: z.array(revisionSchema),
  summary: documentSummarySchema,
});

export const editableSnapshotSchema = z.object({
  baseRevisionId: z.string().nullish(),
  manuscriptAware: z.boolean().optional(),
  cards: z.array(cardSchema),
  contents: z.array(contentSchema),
  manuscript: manuscriptSchema.nullish(),
  documentId: z.string().min(1),
});

const saveResultSchema = z.object({
  revisionId: z.string().min(1),
  savedAtMs: z.number().int().nonnegative(),
});

export async function loadCurrentDocumentSnapshot(): Promise<DocumentSnapshot> {
  try {
    return snapshotSchema.parse(await invoke("load_current_document"));
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function loadCurrentDocumentClock(): Promise<DocumentClock> {
  try {
    return documentClockSchema.parse(await invoke("load_current_document_clock"));
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function saveCurrentDocumentSnapshot(
  snapshot: EditableDocumentSnapshot,
): Promise<SaveDocumentResult> {
  try {
    return saveResultSchema.parse(
      await invoke("save_current_document", {
        snapshot: editableSnapshotSchema.parse(snapshot),
      }),
    );
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function saveDocumentSnapshotAtPath(
  path: string,
  snapshot: EditableDocumentSnapshot,
): Promise<SaveDocumentResult> {
  try {
    return saveResultSchema.parse(
      await invoke("save_document", {
        path,
        snapshot: editableSnapshotSchema.parse(snapshot),
      }),
    );
  } catch (error) {
    throw normalizeError(error);
  }
}


export async function saveDocumentRecoveryCopy(path: string, snapshot: EditableDocumentSnapshot) {
  try {
    return documentSummarySchema.parse(await invoke("save_document_recovery_copy", {
      path,
      snapshot: editableSnapshotSchema.parse(snapshot),
    }));
  } catch (error) {
    throw normalizeError(error);
  }
}
