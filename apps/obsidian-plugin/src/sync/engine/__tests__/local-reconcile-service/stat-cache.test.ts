import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { localFile, TEST_VAULT_KEY } from "./helpers";

describe("SyncLocalReconcileService stat cache", () => {
  it("skips reading unchanged files when local stat cache matches", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const hash = await hashBytes(encodeUtf8("same body"));
    await store.upsertEntry({
      entryId: "entry-unchanged",
      path: "Folder/file.md",
      revision: 4,
      blobId: "blob-unchanged",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: 9,
    });
    let reads = 0;

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            {
              path: "Folder/file.md",
              mtime: 10,
              size: 9,
              async readBytes() {
                reads += 1;
                return encodeUtf8("same body");
              },
            },
          ];
        },
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(reads).toBe(0);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it("updates only local stat cache when hash still matches", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-stat-changed",
      path: "Folder/file.md",
      revision: 4,
      blobId: "blob-stat-changed",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [localFile("Folder/file.md", bytes)];
        },
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.getEntryById("entry-stat-changed")).toMatchObject({
      entryId: "entry-stat-changed",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });
});

describe("a file that cannot be read during a scan", () => {
  it("is skipped instead of failing the whole scan", async () => {
    // Reading fails for ordinary reasons while a vault is being edited: the
    // file was renamed since the listing, Obsidian is mid-save, the OS will not
    // hand it over yet. The scan is what tells the engine what to sync, so
    // losing all of it to one file made errors feel like a daily occurrence.
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Notes/readable.md", encodeUtf8("body")),
            {
              path: "Notes/vanished.md",
              mtime: 10,
              size: 4,
              async readBytes(): Promise<Uint8Array> {
                throw new Error("ENOENT: no such file or directory");
              },
            },
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    // The readable file still gets queued; the unreadable one is simply left
    // for the next scan rather than taking this one down with it.
    expect(result.filesQueuedForUpsert).toBe(1);
    await store.close();
  });
});
