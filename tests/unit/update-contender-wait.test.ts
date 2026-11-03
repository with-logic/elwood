/** Contender waiting is bounded and never evicts a live owner (PRD §9.2, C-PERF-04). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-04 contender wait expires without evicting the active owner", async () => {
  const root = tempDir("elwood-update-wait-");
  let release!: () => void;
  const owner = coordinatedAutoupdate(
    "codex",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { root },
  );
  await expect.poll(() => typeof release).toBe("function");
  const path = updateLockPath("codex", root);
  const before = await readFile(join(path, "owner"), "utf8");
  const update = vi.fn(() => Promise.resolve());
  await expect(
    coordinatedAutoupdate("codex", update, { root, waitMs: 10, pollMs: 1 }),
  ).rejects.toMatchObject({
    code: "codex_update_failed",
    details: { updateReason: "active_owner" },
  });
  expect(update).not.toHaveBeenCalled();
  expect(await readFile(join(path, "owner"), "utf8")).toBe(before);
  release();
  await owner;
});

test("C-PERF-04 a live owner is never evicted solely because staleMs elapsed", async () => {
  const root = tempDir("elwood-update-live-");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      attempts += 1;
      entered.resolve();
      await release.promise;
    },
    { root },
  );
  try {
    await entered.promise;
    await expect(
      coordinatedAutoupdate(
        "codex",
        () => {
          attempts += 1;
          return Promise.resolve();
        },
        { root, pollMs: 2, staleMs: 5, waitMs: 40 },
      ),
    ).rejects.toMatchObject({
      details: { updateReason: "active_owner" },
    });
    expect(attempts).toBe(1);
  } finally {
    release.resolve();
    await owner;
  }
});

// `update_active` is shared behaviour but each adapter has its own preflight path, so both
// are exercised: a Claude-only regression would otherwise leave the suite green.
test.each([
  // The priming version is the pre-update one and must itself clear the adapter's minimum,
  // so the priming preflight succeeds and only the cache's staleness is under test.
  ["codex", preflightCodex, "codex-cli 0.155.0", "0.155.0", "codex update", "codex-cli 0.154.0"],
  ["claude", preflightClaude, "2.1.145", "2.1.145", "claude update", "2.1.144"],
] as const)("C-PERF-04 a %s contender that stops waiting starts from the installed CLI with update_active", async (adapter, preflight, versionOutput, installedVersion, updateCommand, stalePriming) => {
  const root = tempDir("elwood-update-wait-warning-");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    adapter,
    () => {
      entered.resolve();
      return release.promise;
    },
    { root },
  );
  await entered.promise;
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((updating, update) =>
    coordinatedAutoupdate(updating, update, { root, pollMs: 1, waitMs: 10 }),
  );
  const commands: string[] = [];
  let versionReply: string = stalePriming;
  setCommandRunnerForTests((_command, args) => {
    commands.push(args.join(" "));
    return { status: 0, stdout: versionReply, stderr: "" };
  });
  try {
    // Prime the version cache with the pre-update version, as a first preflight would. The
    // contended attempt must still re-read it (C-PERF-02: invalidate after every attempt,
    // including a peer-owned one), or it would report this stale version instead.
    await preflight(false, false);
    const primingReads = commands.length;
    expect(primingReads).toBeGreaterThan(0);
    versionReply = versionOutput;
    expect(await preflight(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_active",
      installedVersion,
      raw: "",
    });
    // A fresh read happened after the peer-owned attempt, and no local updater ran.
    expect(commands.length).toBeGreaterThan(primingReads);
    expect(commands.some((command) => command.includes(updateCommand))).toBe(false);
  } finally {
    release.resolve();
    await owner;
    resetAutoupdateForTests();
  }
});
