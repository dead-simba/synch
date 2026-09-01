import { describe, expect, it, vi } from "vitest";

import { PullManifestPlanner } from "./pull-manifest-planner";

/**
 * Two identities for one path, with identical bytes, is not a conflict.
 *
 * The phone held a file at a path, the desktop uploaded its own record for the
 * same path, and adoption was refused because nothing was queued locally. So a
 * conflict copy of a file identical to the one already there was written - and
 * again on the next revision, and the next. Observed as a new copy every few
 * seconds, filling the vault.
 */

vi.mock("../core/crypto", () => ({
  decryptSyncMetadata: async () => ({ path: "Images/Plan ", hash: "hash-1" }),
}));

const REMOTE_HASH = "hash-1";

function planner(pathOwner: unknown) {
  return new PullManifestPlanner({
    getRemoteVaultKey: () => new Uint8Array(32),
    vaultAdapter: { exists: async () => false },
    now: () => 0,
  } as never) as unknown as {
    findAdoptableLocalPathOwner: (...args: unknown[]) => Promise<unknown>;
  };
}

const store = (pending: unknown) =>
  ({ getDirtyEntryMutation: async () => pending }) as never;

const owner = (overrides: Record<string, unknown> = {}) => ({
  entryId: "local-1",
  path: "Images/Plan ",
  revision: 0,
  hash: REMOTE_HASH,
  deleted: false,
  ...overrides,
});

const remoteState = { entryId: "remote-1" } as never;
const metadata = { path: "Images/Plan ", hash: REMOTE_HASH } as never;

describe("a remote entry colliding with an identical local file", () => {
  it("is adopted rather than copied when nothing is queued locally", async () => {
    const adopted = await planner(owner()).findAdoptableLocalPathOwner(
      store(null),
      remoteState,
      metadata,
      owner(),
      REMOTE_HASH,
    );

    expect(adopted).toMatchObject({ hashMatches: true, pending: null });
  });

  it("is still a real conflict when the bytes differ", async () => {
    // Different content at the same path is exactly what a conflict copy is
    // for. Adopting here would silently drop one side.
    const different = owner({ hash: "hash-2" });
    const adopted = await planner(different).findAdoptableLocalPathOwner(
      store(null),
      remoteState,
      metadata,
      different,
      REMOTE_HASH,
    );

    expect(adopted).toBeNull();
  });

  it("does not adopt a local file that has already synced", async () => {
    // A path owner with a revision is a tracked file in its own right, not a
    // stray duplicate identity.
    const synced = owner({ revision: 4 });
    const adopted = await planner(synced).findAdoptableLocalPathOwner(
      store(null),
      remoteState,
      metadata,
      synced,
      REMOTE_HASH,
    );

    expect(adopted).toBeNull();
  });
});
