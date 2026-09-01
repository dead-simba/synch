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

function state(entryId: string, encryptedMetadata: string) {
  return {
    entryId,
    revision: 1,
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
});
