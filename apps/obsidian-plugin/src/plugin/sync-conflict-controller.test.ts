import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

import { SynchSyncConflictController } from "./sync-conflict-controller";

/**
 * Settling a conflict destroys one of two versions of the user's writing, so
 * the rules matter more than the convenience: the losing side goes to the
 * trash rather than being erased, and the surviving text keeps the original
 * path so links and sync both continue to point at it.
 */

function file(path: string, mtime = 1_000, size = 10): TFile {
  const created = Object.create(TFile.prototype) as TFile;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return Object.assign(created, {
    path,
    name,
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "",
    stat: { mtime, size, ctime: 0 },
  });
}

function createPlugin(files: TFile[], contents: Record<string, string> = {}) {
  const trashFile = vi.fn(async () => {});
  const modifyBinary = vi.fn(async () => {});
  const createBinary = vi.fn(async () => {});
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
      cachedRead: async (f: TFile) => contents[f.path] ?? "",
      readBinary: async (f: TFile) => new TextEncoder().encode(contents[f.path] ?? ""),
      modifyBinary,
      createBinary,
    },
    fileManager: { trashFile },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
  };
  return { plugin: { app } as never, trashFile, modifyBinary, createBinary };
}

const ORIGINAL = "Notes/Plan.md";
const COPY = "Notes/Plan.sync-conflict-20260901-081141.md";

describe("finding conflict copies", () => {
  it("pairs each copy with the file it came from", () => {
    const { plugin } = createPlugin([file(ORIGINAL, 2_000, 30), file(COPY, 3_000, 42)]);
    const [conflict] = new SynchSyncConflictController({ plugin }).listConflicts();

    expect(conflict).toMatchObject({
      originalPath: ORIGINAL,
      conflictPath: COPY,
      originalSizeBytes: 30,
      conflictSizeBytes: 42,
      comparable: true,
    });
  });

  it("still lists a copy whose original is gone", () => {
    // That copy may be the only surviving version, which makes it the most
    // important one to show - there is just nothing to compare it against.
    const { plugin } = createPlugin([file(COPY)]);
    const [conflict] = new SynchSyncConflictController({ plugin }).listConflicts();

    expect(conflict?.conflictPath).toBe(COPY);
    expect(conflict?.comparable).toBe(false);
  });

  it("does not mistake an ordinary note for a conflict copy", () => {
    const { plugin } = createPlugin([file("Notes/Plan.md"), file("Notes/sync notes.md")]);

    expect(new SynchSyncConflictController({ plugin }).listConflicts()).toEqual([]);
  });

  it("offers the newest conflict first", () => {
    const { plugin } = createPlugin([
      file("A.sync-conflict-20260101-101010.md"),
      file("B.sync-conflict-20260901-081141.md"),
    ]);

    expect(
      new SynchSyncConflictController({ plugin })
        .listConflicts()
        .map((c) => c.originalPath),
    ).toEqual(["B.md", "A.md"]);
  });
});

describe("settling a conflict", () => {
  it("keeping your version trashes the copy and leaves the file untouched", async () => {
    const { plugin, trashFile, modifyBinary } = createPlugin([file(ORIGINAL), file(COPY)]);
    const controller = new SynchSyncConflictController({ plugin });
    const [conflict] = controller.listConflicts();

    await controller.resolveConflict(conflict!, "original");

    expect(modifyBinary).not.toHaveBeenCalled();
    expect(trashFile).toHaveBeenCalledWith(expect.objectContaining({ path: COPY }));
  });

  it("keeping the copy writes it into the original path, not a rename", async () => {
    // The original path is what the rest of the vault links to and what sync
    // already tracks, so the copy's text has to travel as an ordinary edit of
    // that file. Renaming instead would break every link pointing at it.
    const { plugin, trashFile, modifyBinary } = createPlugin(
      [file(ORIGINAL), file(COPY)],
      { [ORIGINAL]: "mine", [COPY]: "theirs" },
    );
    const controller = new SynchSyncConflictController({ plugin });
    const [conflict] = controller.listConflicts();

    await controller.resolveConflict(conflict!, "conflict");

    const [target, bytes] = modifyBinary.mock.calls[0] as [TFile, Uint8Array];
    expect(target.path).toBe(ORIGINAL);
    expect(new TextDecoder().decode(bytes)).toBe("theirs");
    expect(trashFile).toHaveBeenCalledWith(expect.objectContaining({ path: COPY }));
  });

  it("never erases the losing version outright", async () => {
    // Trash, not delete: a wrong choice should cost an undo, not the writing.
    const { plugin, trashFile } = createPlugin([file(ORIGINAL), file(COPY)]);
    const controller = new SynchSyncConflictController({ plugin });
    const [conflict] = controller.listConflicts();

    await controller.resolveConflict(conflict!, "original");

    expect(trashFile).toHaveBeenCalledTimes(1);
  });

  it("restores the file when its original was deleted", async () => {
    const { plugin, createBinary } = createPlugin([file(COPY)], { [COPY]: "the only copy" });
    const controller = new SynchSyncConflictController({ plugin });
    const [conflict] = controller.listConflicts();

    await controller.resolveConflict(conflict!, "conflict");

    expect(createBinary).toHaveBeenCalledWith(ORIGINAL, expect.anything());
  });

  it("refuses to act on a copy that is no longer there", async () => {
    const { plugin } = createPlugin([file(ORIGINAL), file(COPY)]);
    const controller = new SynchSyncConflictController({ plugin });
    const [conflict] = controller.listConflicts();
    const stale = { ...conflict!, conflictPath: "Notes/Gone.sync-conflict-20260901-081141.md" };

    await expect(controller.resolveConflict(stale, "original")).rejects.toThrow(
      "no longer in the vault",
    );
  });
});
