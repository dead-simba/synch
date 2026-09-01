import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { localFile, TEST_VAULT_KEY } from "./helpers";

/**
 * A file that never reached the server has to be noticed again.
 *
 * A queued upload that gets dropped - a rename or a delete between queueing
 * and pushing used to do exactly this - leaves a record that looks settled:
 * the local hash matches the file, nothing is queued, and nothing remote sits
 * behind it. The scan compared hashes only, so it kept agreeing the file was
 * fine, and the file silently never synced while progress counted it as
 * outstanding. Seen in a real vault as "syncing 99% - 1527 / 1529" that never
 * finished, on a file that had been sitting unsynced for weeks.
 */

const BYTES = encodeUtf8("floor plan");
const PATH = "Images/V2.2 Ground Floor ";

async function reconcile(store: Awaited<ReturnType<typeof createInitializedTestSyncStore>>) {
  return await new SyncLocalReconcileService({
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    shouldSyncPath: () => true,
    scanner: {
      async listFiles() {
        return [localFile(PATH, BYTES)];
      },
    },
  }).reconcileOnce();
}

describe("a local file that never reached the server", () => {
  it("is queued again even though its hash still matches", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    // Exactly the stuck shape: known locally, hash current, nothing pending,
    // nothing remote.
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

    const result = await reconcile(store);

    expect(result.filesQueuedForUpsert).toBe(1);
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.op).toBe("upsert");
  });

  it("leaves a file that did reach the server alone", async () => {
    // The common case by far. Re-queueing every settled file on every scan
    // would upload the whole vault continuously.
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const hash = await hashBytes(BYTES);
    await store.upsertEntry({
      entryId: "entry-1",
      path: PATH,
      revision: 3,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.applyLocalState({
      entryId: "entry-1",
      path: PATH,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: BYTES.byteLength,
    });

    const result = await reconcile(store);

    expect(result.filesQueuedForUpsert).toBe(0);
    expect(await store.listDirtyEntries()).toHaveLength(0);
  });
});
