/**
 * An aborted updater whose process group survives keeps the update lease, so no second
 * host installs over a still-running installer (PRD §9.2, C-PERF-04). The groups here are
 * real and detached; production code only observes them.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { elwoodError } from "../../../src/core/errors.ts";
import { processGroupGone } from "../../../src/runtime/probe-cleanup.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { readOwner } from "../../../src/runtime/update/owner.ts";
import { tempDir } from "../../helpers/tmp.ts";

function spawnGroup(): { id: number; killGroup: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const id = child.pid as number;
  const killGroup = async (): Promise<void> => {
    if (processGroupGone(id)) return;
    process.kill(-id, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (!processGroupGone(id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (!processGroupGone(id)) throw new Error(`fixture process group ${id} outlived SIGKILL`);
  };
  return { id, killGroup };
}

/** What an aborted update probe throws when it could not confirm its group gone. */
const abortedWith = (processGroupId: number): Error =>
  elwoodError("codex_update_failed", "`codex update` was aborted.", {
    cleanupProcessGroupId: processGroupId,
  });

test("C-PERF-04 an aborted update whose group survives hands the lease to that group", async () => {
  const group = spawnGroup();
  const root = tempDir("elwood-retain-");
  const path = updateLockPath("codex", root);
  try {
    await expect(
      coordinatedAutoupdate("codex", () => Promise.reject(abortedWith(group.id)), { root }),
    ).rejects.toThrow("was aborted");
    // The lease outlives this process, recorded as held by the surviving group alone.
    expect(await readOwner(path)).toMatchObject({ ownedProcessGroupIds: [group.id] });
    // A contender sees a live group and says so rather than installing over it.
    await expect(
      coordinatedAutoupdate("codex", () => Promise.resolve(), {
        root,
        pollMs: 2,
        staleMs: 5,
        waitMs: 200,
      }),
    ).rejects.toMatchObject({ details: { updateReason: "cleanup_pending" } });
  } finally {
    await group.killGroup();
  }
});

test("C-PERF-04 a group that exits within the cleanup window never retains the lease", async () => {
  const group = spawnGroup();
  const root = tempDir("elwood-retain-exits-");
  const path = updateLockPath("codex", root);
  // Gone before the update settles, so there is nothing left to wait for.
  await group.killGroup();
  await expect(
    coordinatedAutoupdate("codex", () => Promise.reject(abortedWith(group.id)), { root }),
  ).rejects.toThrow("was aborted");
  expect(existsSync(path)).toBe(false);
  // The next updater proceeds immediately rather than waiting out a retained lease.
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    { root, pollMs: 2, staleMs: 5 },
  );
  expect(ran).toBe(true);
});

test("C-PERF-04 a retained lease is recovered once its group exits", async () => {
  const group = spawnGroup();
  const root = tempDir("elwood-retain-released-");
  await expect(
    coordinatedAutoupdate("codex", () => Promise.reject(abortedWith(group.id)), { root }),
  ).rejects.toThrow("was aborted");
  await group.killGroup();
  let ran = false;
  // The lease is far younger than any stale bound, so only the group's exit can free it.
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    { root, pollMs: 2, staleMs: 30_000 },
  );
  expect(ran).toBe(true);
});

test("C-PERF-04 an update that cleaned up after itself releases the lease as usual", async () => {
  const root = tempDir("elwood-retain-clean-");
  const path = updateLockPath("codex", root);
  // A failure naming no unresolved group retains nothing.
  await expect(
    coordinatedAutoupdate("codex", () => Promise.reject(new Error("update failed")), { root }),
  ).rejects.toThrow("update failed");
  expect(existsSync(path)).toBe(false);
});
