import { vi } from "vitest";
import { refreshRecentDocumentPaths } from "../src/storage/recentDocuments";
import { readLastDocumentPath, readRecentDocumentPaths, rememberLastDocumentPath, forgetRecentDocumentPath } from "../src/storage/lastDocument";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => { invoke.mockReset(); });

it("checks every recent path and persists the surviving recency order", async () => {
  rememberLastDocumentPath("/tmp/older.fable");
  rememberLastDocumentPath("/tmp/missing.fable");
  rememberLastDocumentPath("/tmp/newer.fable");
  invoke.mockResolvedValue(["/tmp/newer.fable", "/tmp/older.fable"]);
  expect(await refreshRecentDocumentPaths()).toEqual(["/tmp/newer.fable", "/tmp/older.fable"]);
  expect(invoke).toHaveBeenCalledWith("existing_document_paths", {
    paths: ["/tmp/newer.fable", "/tmp/missing.fable", "/tmp/older.fable"],
  });
  expect(readRecentDocumentPaths()).toEqual(["/tmp/newer.fable", "/tmp/older.fable"]);
  expect(readLastDocumentPath()).toBe("/tmp/newer.fable");
});

it("removes a missing legacy path from both storage keys", async () => {
  window.localStorage.setItem("fablecraft:last-document-path", "/tmp/missing.fable");
  invoke.mockResolvedValue([]);
  expect(await refreshRecentDocumentPaths()).toEqual([]);
  expect(readLastDocumentPath()).toBeNull();
  expect(window.localStorage.getItem("fablecraft:last-document-path")).toBeNull();
  expect(window.localStorage.getItem("fablecraft:recent-document-paths")).toBeNull();
});

it("preserves saved history when the filesystem check fails", async () => {
  rememberLastDocumentPath("/tmp/story.fable");
  invoke.mockRejectedValue(new Error("permission denied"));
  await expect(refreshRecentDocumentPaths()).rejects.toThrow("permission denied");
  expect(readRecentDocumentPaths()).toEqual(["/tmp/story.fable"]);
});

it("preserves concurrent opens and does not restore concurrently removed paths", async () => {
  rememberLastDocumentPath("/tmp/missing.fable");
  rememberLastDocumentPath("/tmp/deleted.fable");
  invoke.mockImplementation(async () => {
    rememberLastDocumentPath("/tmp/new.fable");
    forgetRecentDocumentPath("/tmp/deleted.fable");
    return ["/tmp/deleted.fable"];
  });
  expect(await refreshRecentDocumentPaths()).toEqual([]);
  expect(readRecentDocumentPaths()).toEqual(["/tmp/new.fable"]);
});
