import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";
import {
  contentJsonForPlainText,
  replaceCardContent,
} from "../src/domain/document/content";
import { forceSaveCurrentDocument } from "../src/storage/forceSave";
import { useDocumentAutosave } from "../src/storage/useDocumentAutosave";
import { useDocumentStore } from "../src/state/documentStore";

const saveDocumentSnapshotAtPath = vi.fn();

vi.mock("../src/storage/documentSnapshots", () => ({
  saveDocumentSnapshotAtPath: (...args: unknown[]) =>
    saveDocumentSnapshotAtPath(...args),
}));

function TestHarness() {
  useDocumentAutosave();
  return null;
}

function resetDocumentStore() {
  useDocumentStore.setState({
    dirty: false,
    editingFuture: [],
    editingPast: [],
    errorMessage: null,
    lastSavedAtMs: null,
    navigationFuture: [],
    navigationPast: [],
    saveState: "idle",
    snapshot: null,
  });
}

describe("useDocumentAutosave", () => {
  const originalActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    saveDocumentSnapshotAtPath.mockReset();
    resetDocumentStore();
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    vi.useRealTimers();
    document.body.innerHTML = "";
    resetDocumentStore();
  });

  it("serializes autosave and force flush while new manuscript edits keep their own base revision", async () => {
    let finish!: (result: { revisionId: string; savedAtMs: number }) => void;
    saveDocumentSnapshotAtPath
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ revisionId: "second", savedAtMs: 22 });
    const root = createRoot(document.createElement("div"));
    const initial = makeDocumentSnapshot();
    initial.manuscript = {
      id: "be9e3754-e23e-41d5-9aca-ded015dfc6a1",
      contentJson: contentJsonForPlainText("draft"),
      passages: [],
    };
    useDocumentStore.getState().hydrateSnapshot(initial);
    useDocumentStore.setState({ dirty: true });
    await act(async () => { root.render(<TestHarness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    const first = saveDocumentSnapshotAtPath.mock.calls[0]![1];
    expect(first.baseRevisionId).toBeNull();
    expect(first.manuscript.contentJson).toContain("draft");

    let flushed!: ReturnType<typeof forceSaveCurrentDocument>;
    await act(async () => {
      useDocumentStore.getState().updateSnapshot((snapshot) => ({
        ...snapshot,
        manuscript: { ...snapshot.manuscript!, contentJson: contentJsonForPlainText("draft and local tail") },
      }));
      flushed = forceSaveCurrentDocument();
      expect(saveDocumentSnapshotAtPath).toHaveBeenCalledTimes(1);
      finish({ revisionId: "first", savedAtMs: 21 });
      await flushed;
    });
    const second = saveDocumentSnapshotAtPath.mock.calls[1]![1];
    expect(second.baseRevisionId).toBe("first");
    expect(second.manuscript.contentJson).toContain("draft and local tail");
    const state = useDocumentStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.snapshot?.revisions).toEqual([
      { id: "second", createdAtMs: 22 },
      { id: "first", createdAtMs: 21 },
    ]);
    await act(async () => root.unmount());
  });

  it("keeps the local manuscript and stops autosave after an MCP write wins the revision", async () => {
    saveDocumentSnapshotAtPath.mockRejectedValue({
      code: "stale_document_revision", message: "Changed on disk",
    });
    const root = createRoot(document.createElement("div"));
    const initial = makeDocumentSnapshot();
    initial.manuscript = {
      id: "be9e3754-e23e-41d5-9aca-ded015dfc6a1", contentJson: contentJsonForPlainText("draft"), passages: [],
    };
    initial.revisions = [{ id: "shared-base", createdAtMs: 20, snapshot: "{}" }];
    useDocumentStore.getState().hydrateSnapshot(initial);
    await act(async () => { root.render(<TestHarness />); });
    await act(async () => {
      useDocumentStore.getState().updateSnapshot((snapshot) => ({
        ...snapshot,
        manuscript: { ...snapshot.manuscript!, contentJson: contentJsonForPlainText("unsaved local text") },
      }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    const state = useDocumentStore.getState();
    expect(state.revisionConflict).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.snapshot?.manuscript?.contentJson).toContain("unsaved local text");
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    expect(saveDocumentSnapshotAtPath).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("ignores an in-flight save failure after clearing a trashed document", async () => {
    let rejectSave!: (reason: Error) => void;
    saveDocumentSnapshotAtPath.mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
    const root = createRoot(document.createElement("div"));
    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());
    useDocumentStore.setState({ dirty: true });
    await act(async () => { root.render(<TestHarness />); });
    await act(async () => { vi.advanceTimersByTime(450); });
    await act(async () => { useDocumentStore.getState().clearDocument(); });
    await act(async () => { rejectSave(new Error("File moved to Trash")); });
    expect(useDocumentStore.getState().snapshot).toBeNull();
    expect(useDocumentStore.getState().saveState).toBe("idle");
    expect(useDocumentStore.getState().errorMessage).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("marks the document saved after a successful autosave cycle", async () => {
    saveDocumentSnapshotAtPath.mockResolvedValue({
      revisionId: "rev-success",
      savedAtMs: 1_700,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());
    useDocumentStore.setState({ dirty: true });

    await act(async () => {
      root.render(<TestHarness />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(saveDocumentSnapshotAtPath).toHaveBeenCalledTimes(1);
    expect(saveDocumentSnapshotAtPath).toHaveBeenCalledWith(
      "/tmp/story.fable",
      expect.objectContaining({ documentId: "doc-1" }),
    );
    expect(useDocumentStore.getState().saveState).toBe("saved");
    expect(useDocumentStore.getState().dirty).toBe(false);
    expect(useDocumentStore.getState().errorMessage).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("surfaces the save failure to the store and recovers on the next successful save", async () => {
    saveDocumentSnapshotAtPath.mockRejectedValueOnce(new Error("offline"));
    saveDocumentSnapshotAtPath.mockResolvedValue({
      revisionId: "rev-recover",
      savedAtMs: 2_100,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());
    useDocumentStore.setState({ dirty: true });

    await act(async () => {
      root.render(<TestHarness />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(useDocumentStore.getState().saveState).toBe("error");
    expect(useDocumentStore.getState().errorMessage).toBe("offline");
    expect(useDocumentStore.getState().dirty).toBe(true);

    await act(async () => {
      useDocumentStore.getState().updateSnapshot((snapshot) =>
        replaceCardContent(snapshot, {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Second attempt"),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(saveDocumentSnapshotAtPath).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().saveState).toBe("saved");
    expect(useDocumentStore.getState().errorMessage).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to a generic message when the thrown value is not an Error", async () => {
    saveDocumentSnapshotAtPath.mockRejectedValue("string-rejection");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());
    useDocumentStore.setState({ dirty: true });

    await act(async () => {
      root.render(<TestHarness />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(useDocumentStore.getState().saveState).toBe("error");
    expect(useDocumentStore.getState().errorMessage).toBe(
      "Autosave failed unexpectedly.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not run when the snapshot is clean", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(makeDocumentSnapshot());

    await act(async () => {
      root.render(<TestHarness />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(saveDocumentSnapshotAtPath).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
