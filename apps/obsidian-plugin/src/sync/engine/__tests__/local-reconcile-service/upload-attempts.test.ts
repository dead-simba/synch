import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { localFile, TEST_VAULT_KEY } from "./helpers";

/**
 * Re-queueing a file that never arrived must not become a loop.
 *
 * Noticing such a file is right - that is how a dropped upload gets another
 * chance. Doing it unconditionally is not: a phone re-uploaded the same blobs
 * roughly fifty-six times a minute, which is around 160,000 requests a day
 * against a 100,000 request daily limit, and never got anywhere.
 */

const BYTES = encodeUtf8("floor plan");
const PATH = "Images/V2.2 Ground Floor ";

function service(store: unknown) {
  return new SyncLocalReconcileService({
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    shouldSyncPath: () => true,
    scanner: {
      async listFiles() {
        return [localFile(PATH, BYTES)];
      },
    },
  } as never);
}

async function neverUploadedEntry(
  store: Awaited<ReturnType<typeof createInitializedTestSyncStore>>,
) {
  await store.applyLocalState({
    entryId: "entry-1",
    path: PATH,
    blobId: "blob-1",
    hash: await hashBytes(BYTES),
    deleted: false,
    updatedAt: 1,
    localMtime: 10,
    localSize: BYTES.byteLength,
  });
}

describe("a file that keeps failing to reach the server", () => {
  it("is parked after a few attempts instead of being uploaded forever", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await neverUploadedEntry(store);
    const reconcile = service(store);

    // Every pass finds the same file with nothing on the server behind it,
    // which is what the failing upload leaves behind.
    for (let pass = 0; pass < 4; pass += 1) {
      await reconcile.reconcileOnce();
      const pending = await store.listDirtyEntries();
      for (const mutation of pending) {
        await store.clearDirtyEntryByMutationId(mutation.mutationId);
      }
    }

    await reconcile.reconcileOnce();
    const blocked = await store.listBlockedDirtyEntriesByReason("prepare_failed");

    expect(blocked).toHaveLength(1);
    expect(await store.listDirtyEntries()).toHaveLength(0);
    await store.close();
  });

  it("does not hold back an edit to a file that has synced before", async () => {
    // The common case. Counting attempts against an already-synced file would
    // eventually stop ordinary edits from going out at all.
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-1",
      path: PATH,
      revision: 5,
      blobId: "blob-old",
      hash: "a-different-hash",
      deleted: false,
      updatedAt: 1,
    });
    const reconcile = service(store);

    for (let pass = 0; pass < 6; pass += 1) {
      await reconcile.reconcileOnce();
      const pending = await store.listDirtyEntries();
      expect(pending.every((mutation) => mutation.status !== "blocked")).toBe(true);
      for (const mutation of pending) {
        await store.clearDirtyEntryByMutationId(mutation.mutationId);
      }
    }

    expect(await store.listBlockedDirtyEntriesByReason("prepare_failed")).toHaveLength(0);
    await store.close();
  });
});
