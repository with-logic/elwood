/**
 * The contender wait's documented 60-second default, and the caches a peer-owned attempt
 * must still invalidate (PRD §5.7, §9.2, C-PERF-02, C-PERF-04).
 */

import { expect, test, vi } from "vitest";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-04 a contender given no waitMs gives up on the documented 60-second bound", async () => {
  const root = tempDir("elwood-update-default-wait-");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      entered.resolve();
      await release.promise;
    },
    { root },
  );
  await entered.promise;
  // The deadline is monotonic, so advancing `performance.now()` is what moves the wait.
  // Nothing here overrides `waitMs`: the default itself is under test.
  const realNow = performance.now.bind(performance);
  const start = realNow();
  let offsetMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
  try {
    const contender = coordinatedAutoupdate("codex", () => Promise.resolve(), { root, pollMs: 1 });
    const settled = contender.then(
      () => "resolved",
      (error: { details?: { updateReason?: string } }) => error.details?.updateReason,
    );
    // Just short of the bound the contender is still waiting.
    offsetMs = 59_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(Promise.race([settled, Promise.resolve("still waiting")])).resolves.toBe(
      "still waiting",
    );
    // Past it, the wait expires rather than continuing.
    offsetMs = 60_001;
    await expect(settled).resolves.toBe("active_owner");
    expect(realNow() - start).toBeLessThan(10_000); // no real minute elapsed
  } finally {
    vi.restoreAllMocks();
    release.resolve();
    await owner;
  }
});

test("C-PERF-02 a peer-owned attempt invalidates the Codex capability probe too", async () => {
  const root = tempDir("elwood-update-capability-");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      entered.resolve();
      await release.promise;
    },
    { root },
  );
  await entered.promise;
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((adapter, update) =>
    coordinatedAutoupdate(adapter, update, { root, pollMs: 1, waitMs: 10 }),
  );
  let helpReply = "--dangerously-bypass-hook-trust";
  setCommandRunnerForTests((_command, args) => ({
    status: 0,
    stdout: args.join(" ").includes("--help") ? helpReply : "codex-cli 0.155.0",
    stderr: "",
  }));
  try {
    // Prime the capability cache from the pre-update CLI, as a first launch would.
    expect(await detectCodexCliCapabilities()).toMatchObject({ supportsHookTrustBypass: true });
    // The peer's update changes what the installed CLI supports.
    helpReply = "";
    await preflightCodex(false, true);
    // A stale capability here would launch Codex with flags the new binary rejects.
    expect(await detectCodexCliCapabilities()).toMatchObject({ supportsHookTrustBypass: false });
  } finally {
    release.resolve();
    await owner;
    resetAutoupdateForTests();
    resetPreflightCacheForTests();
    resetCodexPreflightCacheForTests();
  }
});
