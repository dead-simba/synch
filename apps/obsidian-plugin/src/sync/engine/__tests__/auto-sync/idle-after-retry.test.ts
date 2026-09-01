import { describe, expect, it, vi } from "vitest";

import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import { SyncAutoLoop } from "../../auto-sync";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

/**
 * A retry that finds nothing to retry has to say so.
 *
 * The engine parked itself in retry_wait, and idle is only ever reported at
 * the end of a drain - so with no work left, no drain was coming and no idle
 * was ever reported. The status read "syncing 100% - 1531 / 1531" over a vault
 * that was completely up to date, with no network traffic and nothing being
 * written to disk.
 */
describe("a retry with nothing left to retry", () => {
  it("reports the engine idle instead of waiting forever", async () => {
    vi.useFakeTimers();
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const onIdle = vi.fn();
    const pushPendingMutations = vi.fn(async () => createPushResult());

    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(),
      onIdle,
      syncRetryBaseDelayMs: 50,
    } as never);

    await autoLoop.start();
    onIdle.mockClear();

    // The state the bug left behind: a retry armed, and by the time it fires
    // the work it was for is gone.
    (
      autoLoop as unknown as { scheduleSyncRetry: () => void }
    ).scheduleSyncRetry();

    await vi.advanceTimersByTimeAsync(100);

    expect(onIdle).toHaveBeenCalled();

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });
});
