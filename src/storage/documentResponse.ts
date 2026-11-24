import { z } from "zod";
import type { FablecraftError } from "../types/document";

export const documentIdentitySchema = z.object({
  createdAtMs: z.number().int().nonnegative().optional(),
  documentId: z.string().min(1),
  name: z.string().min(1),
  openedAtMs: z.number().int().nonnegative(),
  path: z.string().min(1),
});

export function normalizeError(error: unknown): FablecraftError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    const maybeError = error as Partial<FablecraftError>;

    return {
      code: maybeError.code ?? "unknown_error",
      details: maybeError.details ?? null,
      message: maybeError.message ?? "Unknown error",
    };
  }

  return {
    code: "unknown_error",
    details: null,
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
