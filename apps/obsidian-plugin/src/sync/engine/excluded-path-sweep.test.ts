import { describe, expect, it, vi } from "vitest";

import { SyncLocalReconcileService } from "./local-reconcile-service";

/**
 * A path the rules exclude must leave the scan alone after one pass.
 *
 * A conflict copy synced before conflict copies were excluded left a row
 * claiming this device held the file. Cleanup could only drop the whole row
 * when nothing remote pointed at it, so with a remote present the row survived
 * with its local side intact - and every scan found the same path and swept it
 * again. Observed as one copy from three weeks earlier rewritten eighty times
 * in a session, with sync never reporting itself done.
 */

function entry(path: string, withRemote: boolean) {
  return {
    entryId: "entry-1",
    local: {
      entryId: "entry-1",
      path,
      blobId: "blob-1",
      hash: "hash-1",
      deleted: false,
      updatedAt: 1,
      localMtime: 1,
      localSize: 1,
    },
    remote: withRemote
      ? { entryId: "entry-1", path, revision: 7, blobId: "blob-1", hash: "hash-1", deleted: false }
      : null,
    dirty: null,
  };
}

function sweep(path: string, withRemote: boolean) {
  const service = new SyncLocalReconcileService({
    shouldSyncPath: (candidate: string) => !candidate.includes(".sync-conflict-"),
  } as never);

  return (
    service as unknown as {
      filterKnownEntries: (entries: unknown[]) => {
        retained: unknown[];
        cleanupUpdates: { entryId: string; clearLocal?: boolean; deleteEntry?: boolean }[];
      };
    }
  ).filterKnownEntries([entry(path, withRemote)]);
}

describe("sweeping a local entry the rules now exclude", () => {
  it("forgets this device holds it, so the next scan does not find it again", () => {
    const { cleanupUpdates, retained } = sweep(
      "Journal/Aug 07, 2026.sync-conflict-20260807-195823.md",
      true,
    );

    expect(retained).toHaveLength(0);
    expect(cleanupUpdates[0]).toMatchObject({ clearLocal: true, deleteEntry: false });
  });

  it("still drops the whole row when nothing remote points at it", () => {
    const { cleanupUpdates } = sweep(
      "Journal/Aug 07, 2026.sync-conflict-20260807-195823.md",
      false,
    );

    expect(cleanupUpdates[0]).toMatchObject({ deleteEntry: true });
  });

  it("leaves an ordinary file alone", () => {
    const { retained, cleanupUpdates } = sweep("Journal/Aug 07, 2026.md", true);

    expect(retained).toHaveLength(1);
    expect(cleanupUpdates).toHaveLength(0);
  });
});
