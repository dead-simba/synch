import { describe, expect, it, vi } from "vitest";

import { PullEntryStateApplier } from "./pull-entry-state-applier";

/**
 * One damaged record must not hold the vault hostage.
 *
 * A single entry whose metadata would not decrypt stopped the whole pull. The
 * cursor never advanced, so every retry fetched the same record and failed in
 * the same place - and nothing else in the vault could sync past it.
 */
vi.mock("../core/crypto", () => ({
  decryptSyncMetadata: async (_key: unknown, encrypted: string) => {
    if (encrypted === "damaged") {
      throw new Error("Could not decrypt metadata for entry bad@1.");
    }
    return { path: `${encrypted}.md`, hash: "hash-1" };
  },
}));

function state(entryId: string, encryptedMetadata: string, revision = 1) {
  return {
    entryId,
    revision,
    blobId: `blob-${entryId}`,
    encryptedMetadata,
    deleted: false,
    updatedSeq: 1,
    updatedAt: 1,
  } as never;
}

describe("an entry whose metadata cannot be decrypted", () => {
  it("is skipped so the rest of the batch still syncs", async () => {
    const onUndecryptableEntry = vi.fn();
    const applier = new PullEntryStateApplier({
      getApiBaseUrl: () => "https://example.invalid",
      getRemoteVaultKey: () => new Uint8Array(32),
      vaultAdapter: {} as never,
      pullClient: {} as never,
      onUndecryptableEntry,
    } as never);

    const items = await applier.createManifestItems([
      state("good-1", "notes/one"),
      state("bad", "damaged"),
      state("good-2", "notes/two"),
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.state.entryId)).toEqual(["good-1", "good-2"]);
    expect(onUndecryptableEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "bad", revision: 1 }),
    );
  });

  it("passes on the facts that survive the failure, so the item can be found", async () => {
    // The path is inside the metadata that will not decrypt, so it cannot be
    // named. When the item never reached this device there is no local row to
    // fall back on either, and a bare UUID is not something anyone can act on.
    // The write time and whether it was a deletion are not encrypted, and they
    // are enough to find the file on the device that does have it.
    const onUndecryptableEntry = vi.fn();
    const applier = new PullEntryStateApplier({
      getApiBaseUrl: () => "https://example.invalid",
      getRemoteVaultKey: () => new Uint8Array(32),
      vaultAdapter: {} as never,
      pullClient: {} as never,
      onUndecryptableEntry,
    } as never);

    const damaged = { ...(state("bad", "damaged") as object), updatedAt: 1_788_231_576_586 };
    await applier.createManifestItems([damaged as never]);

    expect(onUndecryptableEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "bad",
        updatedAt: 1_788_231_576_586,
        deleted: false,
      }),
    );
  });

  it("reports every revision of the same bad record, leaving the runtime to collapse them", async () => {
    // A backlog delivers each committed revision in turn, so one bad record
    // committed five times arrives five times. The applier stays dumb about
    // that; the runtime is what must not show five notices.
    const onUndecryptableEntry = vi.fn();
    const applier = new PullEntryStateApplier({
      getApiBaseUrl: () => "https://example.invalid",
      getRemoteVaultKey: () => new Uint8Array(32),
      vaultAdapter: {} as never,
      pullClient: {} as never,
      onUndecryptableEntry,
    } as never);

    for (const revision of [2, 3, 4, 5, 6]) {
      await applier.createManifestItems([state("bad", "damaged", revision)]);
    }

    expect(onUndecryptableEntry).toHaveBeenCalledTimes(5);
    expect(onUndecryptableEntry.mock.calls.map(([event]) => event.revision)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });
});
