import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { editableSnapshotSchema, normalizeError, revisionSchema, snapshotSchema } from "./documentSnapshots";
import type { DocumentSummary } from "../types/document";

const historyRangeSchema = z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() });
const historyChangeSchema = z.object({
  description: z.string(),
  kind: z.enum(["cardAdded", "cardDeleted", "cardMoved", "cardEdited", "manuscript"]),
  card: z.object({ id: z.string(), label: z.string() }).optional(),
  characters: z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).optional(),
  cardId: z.string().optional(),
  passage: historyRangeSchema.optional(),
  cardRange: historyRangeSchema.optional(),
  addedRanges: z.array(historyRangeSchema).optional(),
});

const historyComparisonSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("initial") }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("compared"), changes: z.array(historyChangeSchema) }),
]);

const historyEntrySchema = revisionSchema.pick({ id: true, createdAtMs: true })
  .extend({ sequence: z.number().int() });
const historyPageSchema = z.object({
  entries: z.array(historyEntrySchema),
  hasMore: z.boolean(),
  headId: z.string().nullable(),
  maintenanceAtMs: z.number().nullable(),
  selectedRetained: z.boolean(),
  previousVisible: z.record(z.string().nullable()).default({}),
  comparisons: z.record(historyComparisonSchema).default({}),
  preparing: z.boolean().default(false),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;

export interface HistoryFirstPage {
  page: HistoryPage | null;
  pending: Promise<HistoryPage> | null;
}

async function historyCommand<T>(
  command: string,
  document: DocumentSummary,
  args: Record<string, unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
) {
  try {
    return schema.parse(await invoke(command, {
      path: document.path,
      documentId: document.documentId,
      ...args,
    }));
  } catch (error) {
    throw normalizeError(error);
  }
}

export function listDocumentHistory(
  document: DocumentSummary,
  before: HistoryEntry | null,
  selected: string | null,
  known?: Pick<HistoryPage, "headId" | "maintenanceAtMs">,
) {
  return historyCommand("list_document_history", document, { before, selected, known }, historyPageSchema);
}

export function preloadHistoryFirstPage(document: DocumentSummary, first: HistoryFirstPage) {
  first.pending ??= listDocumentHistory(document, null, null).then((page) => {
    if (!page.preparing) first.page = page;
    return page;
  }).finally(() => { first.pending = null; });
  return first.pending;
}

export function loadHistoricalSnapshot(document: DocumentSummary, revisionId: string) {
  return historyCommand("load_historical_snapshot", document, { revisionId }, editableSnapshotSchema);
}

export function restoreHistoricalSnapshot(document: DocumentSummary, revisionId: string, expectedHead: string | null) {
  return historyCommand("restore_historical_snapshot", document, { revisionId, expectedHead }, snapshotSchema);
}

export type HistoryChange = z.infer<typeof historyChangeSchema>;
export type HistoryComparison = z.infer<typeof historyComparisonSchema>;

export function compareDocumentHistory(
  document: DocumentSummary, revisionIds: string[], baselines?: HistoryPage["previousVisible"], newer?: boolean,
) {
  const requested = baselines ? Object.fromEntries(revisionIds.filter((id) => id in baselines)
    .map((id) => [id, baselines[id]])) : undefined;
  return historyCommand("compare_document_history", document, { revisionIds, baselines: requested, newer }, z.record(historyComparisonSchema));
}

export const historyPageSize = 20;

export function warmDocumentHistory(document: DocumentSummary) {
  return invoke("prepare_document_history", { path: document.path, documentId: document.documentId });
}
