import { hashBytes } from "../core/content";
import { createSyncCryptoContext, type SyncCryptoContext } from "../core/crypto";
import {
  buildLocalDeleteMutation,
  buildLocalUpsertMutation,
} from "../core/mutation-queue";
import type {
  LocalSyncEntryRow,
  RemoteSyncEntryRow,
  SyncReconcileEntryState,
  SyncReconcileEntryUpdate,
} from "../store/store";
import type { SyncReconcileStore, SyncStoreLifecycle } from "../store/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";

const DEFAULT_RECONCILE_HASH_CONCURRENCY = 8;

export interface LocalSyncFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export interface LocalFileScanner {
  listFiles(): Promise<LocalSyncFile[]>;
}

export interface SyncLocalReconcileServiceDeps {
  getSyncStore: () => SyncLocalReconcileStore | null;
  getRemoteVaultKey: () => Uint8Array;
  scanner: LocalFileScanner;
  shouldSyncPath(path: string): boolean;
  hashConcurrency?: number;
}

export interface SyncLocalReconcileStore
  extends SyncReconcileStore,
    Pick<SyncStoreLifecycle, "flush"> {}

export interface ReconcileOnceResult {
  filesScanned: number;
  filesQueuedForUpsert: number;
  filesQueuedForDelete: number;
}

/**
 * How many times one file may be queued for upload, in a single session,
 * without ever reaching the server.
 *
 * Re-queueing a file that never arrived is right - that is how a dropped
 * upload gets a second chance. Doing it unconditionally is not: a file whose
 * upload cannot succeed is then re-uploaded on every scan, forever, burning
 * request quota and never getting anywhere. Three attempts is enough for a
 * transient failure and short enough to stop a loop.
 */
const MAX_UNCONFIRMED_UPLOAD_ATTEMPTS = 3;

export class SyncLocalReconcileService {
  /** Attempts per entry that have not yet resulted in anything on the server. */
  private readonly unconfirmedUploadAttempts = new Map<string, number>();

  constructor(private readonly deps: SyncLocalReconcileServiceDeps) {}

  async reconcileOnce(): Promise<ReconcileOnceResult> {
    const store = this.requireStore();
    const remoteVaultKey = this.deps.getRemoteVaultKey();
    const metadataCrypto = createSyncCryptoContext(remoteVaultKey);
    try {
      return await this.reconcileWithMetadataCrypto(
        store,
        metadataCrypto,
      );
    } finally {
      metadataCrypto.dispose();
    }
  }

  private async reconcileWithMetadataCrypto(
    store: SyncLocalReconcileStore,
    metadataCrypto: Pick<SyncCryptoContext, "encryptMetadata" | "decryptMetadata">,
  ): Promise<ReconcileOnceResult> {
    const localFiles = await this.deps.scanner.listFiles();
    const localPaths = new Set<string>();
    for (const file of localFiles) {
      localPaths.add(file.path);
    }
    const snapshot = await store.listReconcileEntryStates();
    const { retained, cleanupUpdates } = this.filterKnownEntries(snapshot);
    const localByPath = indexLocalEntriesByPath(retained);
    const remoteById = indexRemoteEntriesById(retained);
    const visibleRemoteByPath = indexVisibleRemoteEntriesByPath(retained);
    const pendingDeleteEntriesByPath = await this.indexPendingDeleteEntriesByPath(
      metadataCrypto,
      retained,
    );
    const renameCandidates = new Map<string, LocalSyncEntryRow[]>();
    const reusedEntryIds = new Set<string>();
    const updates: SyncReconcileEntryUpdate[] = [...cleanupUpdates];
    let filesQueuedForUpsert = 0;
    let filesQueuedForDelete = 0;

    for (const state of retained) {
      const entry = state.local;
      if (!entry) {
        continue;
      }
      if (entry.deleted || !entry.path || localPaths.has(entry.path) || !entry.hash) {
        continue;
      }

      const bucket = renameCandidates.get(entry.hash) ?? [];
      bucket.push(entry);
      renameCandidates.set(entry.hash, bucket);
    }

    const hashInputs: ReconcileHashInput[] = [];
    for (const file of localFiles) {
      const existing = localByPath.get(file.path) ?? null;
      const pendingDeleteEntry = pendingDeleteEntriesByPath.get(file.path) ?? null;
      const existingHasPendingDelete =
        !!existing && pendingDeleteEntry?.entryId === existing.entryId;
      const restoredDeletedEntry = existing ? null : pendingDeleteEntry;
      // The stat cache skips a file whose size and timestamp are unchanged,
      // which is what keeps a scan cheap. But "unchanged" is not "synced": an
      // entry that never reached the server has to be looked at however long
      // it has sat still, or it is skipped here forever and nothing downstream
      // ever gets the chance to notice.
      const everUploaded = existing
        ? (remoteById.get(existing.entryId)?.revision ?? 0) > 0
        : false;
      if (!existingHasPendingDelete && everUploaded && canSkipHash(existing, file)) {
        continue;
      }

      hashInputs.push({
        file,
        existing,
        existingHasPendingDelete,
        restoredDeletedEntry,
      });
    }

    // Reading a file can fail for entirely ordinary reasons: it was renamed or
    // deleted since the directory listing, Obsidian is mid-save, the OS will
    // not hand it over this instant. mapWithConcurrency is Promise.all, so one
    // such file used to reject the whole scan - and without a scan the engine
    // cannot work out what to sync at all. A vault being actively edited hits
    // this routinely, which is what made errors feel like they arrived daily.
    //
    // A file skipped here is not lost: the next scan picks it up, and the file
    // watcher queues it the moment it changes again.
    const hashedOrSkipped = await mapWithConcurrency(
      hashInputs,
      this.deps.hashConcurrency ?? DEFAULT_RECONCILE_HASH_CONCURRENCY,
      async (input) => {
        try {
          return {
            ...input,
            hash: await hashBytes(await input.file.readBytes()),
          };
        } catch {
          return null;
        }
      },
    );
    const hashedFiles = hashedOrSkipped.filter(
      (entry): entry is (typeof hashedOrSkipped)[number] & object => entry !== null,
    );

    for (const {
      file,
      existing,
      existingHasPendingDelete,
      restoredDeletedEntry,
      hash,
    } of hashedFiles) {
      // A matching hash means the file has not changed since it was recorded.
      // It does not mean the file ever reached the server: a queued upload
      // that was dropped - a rename or delete between queueing and pushing
      // used to do this - leaves the record looking settled with nothing
      // remote behind it and nothing queued to fix that. Nothing then ever
      // re-queued it, because the hash kept matching, so the file silently
      // never synced while progress counted it as outstanding forever. Seen
      // as "syncing 99% - 1527 / 1529" that never finished.
      const reachedServer = existing
        ? (remoteById.get(existing.entryId)?.revision ?? 0) > 0
        : false;
      if (
        existing &&
        reachedServer &&
        !existingHasPendingDelete &&
        !existing.deleted &&
        existing.hash === hash
      ) {
        updates.push({
          entryId: existing.entryId,
          local: {
            ...existing,
            localMtime: file.mtime,
            localSize: file.size,
          },
        });
        continue;
      }

      const renameMatch =
        !existing && !restoredDeletedEntry
          ? takeRenameCandidate(renameCandidates, hash)
          : null;
      const entry = existing ?? restoredDeletedEntry ?? renameMatch;
      if (renameMatch) {
        reusedEntryIds.add(renameMatch.entryId);
      }
      const remote = entry
        ? remoteById.get(entry.entryId) ?? null
        : visibleRemoteByPath.get(file.path) ?? null;
      const entryId = entry?.entryId ?? remote?.entryId ?? crypto.randomUUID();

      const queued = await buildLocalUpsertMutation({
        metadataCrypto,
        path: file.path,
        entryId,
        base: remote,
        previousLocal: entry,
        hash,
        requireBaseBlob: shouldRequireBaseBlob(file.path, remote),
      });

      // Count only attempts at a file with nothing on the server behind it.
      // Once something lands the count is irrelevant, and an ordinary edit to
      // an already-synced file must never be held back by it.
      const attempts = remote && remote.revision > 0
        ? 0
        : (this.unconfirmedUploadAttempts.get(queued.entryId) ?? 0) + 1;
      if (attempts === 0) {
        this.unconfirmedUploadAttempts.delete(queued.entryId);
      } else {
        this.unconfirmedUploadAttempts.set(queued.entryId, attempts);
      }
      const exhausted = attempts > MAX_UNCONFIRMED_UPLOAD_ATTEMPTS;

      updates.push({
        entryId: queued.entryId,
        dirty: exhausted
          ? { ...queued.mutation, status: "blocked", blockedReason: "prepare_failed" }
          : queued.mutation,
        requireBaseBlob: shouldRequireBaseBlob(file.path, remote),
        local: {
          entryId: queued.entryId,
          path: file.path,
          blobId: queued.blobId,
          hash,
          deleted: false,
          updatedAt: Date.now(),
          localMtime: file.mtime,
          localSize: file.size,
        },
      });
      filesQueuedForUpsert += 1;
    }

    for (const state of retained) {
      const entry = state.local;
      if (!entry) {
        continue;
      }
      if (
        entry.deleted ||
        !entry.path ||
        localPaths.has(entry.path) ||
        reusedEntryIds.has(entry.entryId)
      ) {
        continue;
      }

      const remote = remoteById.get(entry.entryId) ?? null;
      if (!remote || remote.revision === 0) {
        updates.push({
          entryId: entry.entryId,
          clearDirty: true,
          deleteEntry: true,
        });
        continue;
      }

      const deletedPath = entry.path;
      const mutation = await buildLocalDeleteMutation({
        metadataCrypto,
        entryId: entry.entryId,
        base: remote,
        path: deletedPath,
      });
      updates.push({
        entryId: entry.entryId,
        dirty: mutation,
        local: {
          entryId: entry.entryId,
          path: null,
          blobId: null,
          hash: null,
          deleted: true,
          updatedAt: Date.now(),
          localMtime: null,
          localSize: null,
        },
      });
      filesQueuedForDelete += 1;
    }

    await applyReconcileUpdatesInChunks(store, updates);
    await store.flush();

    return {
      filesScanned: localFiles.length,
      filesQueuedForUpsert,
      filesQueuedForDelete,
    };
  }

  private requireStore(): SyncLocalReconcileStore {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    return store;
  }

  private filterKnownEntries(
    entries: SyncReconcileEntryState[],
  ): {
    retained: SyncReconcileEntryState[];
    cleanupUpdates: SyncReconcileEntryUpdate[];
  } {
    const retained: SyncReconcileEntryState[] = [];
    const cleanupUpdates: SyncReconcileEntryUpdate[] = [];

    for (const entry of entries) {
      const local = entry.local;
      if (!local?.path || local.deleted || this.deps.shouldSyncPath(local.path)) {
        retained.push(entry);
        continue;
      }

      // Dropping the whole row only works when nothing remote points at it.
      // With a remote present the row survived with localKnown still set, so
      // the next scan found the same excluded path and swept it again - seen
      // in the wild as one conflict copy from three weeks earlier rewritten
      // eighty times in a single session, while sync never reported itself
      // done. Forgetting the local side ends it: the remote is the server's
      // business, but this device does not hold a file it will never write.
      cleanupUpdates.push({
        entryId: entry.entryId,
        clearDirty: true,
        clearLocal: true,
        deleteEntry: !entry.remote || entry.remote.revision === 0,
      });
    }

    return { retained, cleanupUpdates };
  }

  private async indexPendingDeleteEntriesByPath(
    metadataCrypto: Pick<SyncCryptoContext, "decryptMetadata">,
    entries: SyncReconcileEntryState[],
  ): Promise<Map<string, LocalSyncEntryRow>> {
    const result = new Map<string, LocalSyncEntryRow>();

    for (const entry of entries) {
      const pending = entry.dirty;
      if (!pending || pending.op !== "delete") {
        continue;
      }

      const metadata = await metadataCrypto.decryptMetadata(pending.encryptedMetadata, {
        entryId: pending.entryId,
        revision: pending.baseRevision + 1,
        op: pending.op,
        blobId: pending.blobId,
      });
      const pendingEntry = entry.local;
      if (pendingEntry) {
        result.set(metadata.path, pendingEntry);
      }
    }

    return result;
  }
}

const RECONCILE_UPDATE_CHUNK_SIZE = 500;

interface ReconcileHashInput {
  file: LocalSyncFile;
  existing: LocalSyncEntryRow | null;
  existingHasPendingDelete: boolean;
  restoredDeletedEntry: LocalSyncEntryRow | null;
}

function canSkipHash(
  existing: LocalSyncEntryRow | null,
  file: LocalSyncFile,
): boolean {
  return (
    !!existing &&
    !existing.deleted &&
    !!existing.hash &&
    existing.localMtime === file.mtime &&
    existing.localSize === file.size
  );
}

function takeRenameCandidate(
  candidates: Map<string, LocalSyncEntryRow[]>,
  hash: string,
): LocalSyncEntryRow | null {
  const bucket = candidates.get(hash);
  if (!bucket || bucket.length === 0) {
    return null;
  }

  const match = bucket.shift() ?? null;
  if (bucket.length === 0) {
    candidates.delete(hash);
  }

  return match;
}

function indexLocalEntriesByPath(
  entries: SyncReconcileEntryState[],
): Map<string, LocalSyncEntryRow> {
  const result = new Map<string, LocalSyncEntryRow>();
  for (const entry of entries) {
    const local = entry.local;
    if (local?.path && !local.deleted) {
      result.set(local.path, local);
    }
  }
  return result;
}

function indexRemoteEntriesById(
  entries: SyncReconcileEntryState[],
): Map<string, RemoteSyncEntryRow> {
  const result = new Map<string, RemoteSyncEntryRow>();
  for (const entry of entries) {
    if (entry.remote) {
      result.set(entry.entryId, entry.remote);
    }
  }
  return result;
}

function indexVisibleRemoteEntriesByPath(
  entries: SyncReconcileEntryState[],
): Map<string, RemoteSyncEntryRow> {
  const result = new Map<string, RemoteSyncEntryRow>();
  for (const entry of entries) {
    const remote = entry.remote;
    if (!remote?.path || remote.deleted) {
      continue;
    }
    if (entry.local && entry.local.path !== remote.path) {
      continue;
    }
    result.set(remote.path, remote);
  }
  return result;
}

async function applyReconcileUpdatesInChunks(
  store: SyncLocalReconcileStore,
  updates: SyncReconcileEntryUpdate[],
): Promise<void> {
  for (let index = 0; index < updates.length; index += RECONCILE_UPDATE_CHUNK_SIZE) {
    await store.applyReconcileEntryUpdates(
      updates.slice(index, index + RECONCILE_UPDATE_CHUNK_SIZE),
    );
  }
}

function shouldRequireBaseBlob(
  path: string,
  remote: RemoteSyncEntryRow | null,
): boolean {
  return !!remote && !remote.deleted && !!remote.blobId && isAutoMergeTextPath(path);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length && !firstError) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await mapper(items[index]);
        } catch (error) {
          firstError = firstError ?? error;
        }
      }
    }),
  );

  if (firstError) {
    throw firstError;
  }

  return results;
}
