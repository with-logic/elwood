/**
 * When the group record cannot be written, the owner keeps the obligation itself rather
 * than leaving the lease held for its own lifetime (PRD §9.2, C-PERF-04). The end-to-end
 * proof runs a real long-lived host in `stranded-cleanup.test.ts`; this drives the retry
 * loop in-process so each of its exits is exercised directly.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { processGroupGone } from "../../../src/runtime/probe-cleanup.ts";
import { updateLockPath } from "../../../src/runtime/update/lock.ts";
import * as owner from "../../../src/runtime/update/owner.ts";
import { retainLease } from "../../../src/runtime/update/retained-lease.ts";
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

/** A claimed lease whose record names this process, as an owner mid-update holds it. */
async function claimedLease(prefix: string): Promise<{ path: string; lease: owner.LeaseOwner }> {
  const root = tempDir(prefix);
  const path = updateLockPath("codex", root);
  const lease = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path, { recursive: true });
  writeFileSync(`${path}/owner`, owner.serializeOwner(lease));
  return { path, lease };
}

test("C-PERF-04 a retry that succeeds records the groups and stops retrying", async () => {
  const group = spawnGroup();
  const { path, lease } = await claimedLease("elwood-retain-retry-ok-");
  // Fail only the first write, so the loop runs once and then commits.
  const retain = vi.spyOn(owner, "retainProbeOwner");
  retain.mockRejectedValueOnce(new Error("disk failed"));
  try {
    await retainLease(path, lease, [group.id], 5);
    await expect.poll(() => retain.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(1);
    await expect.poll(() => existsSync(path)).toBe(true);
    expect(await owner.readOwner(path)).toMatchObject({ ownedProcessGroupIds: [group.id] });
  } finally {
    retain.mockRestore();
    await group.killGroup();
  }
});

test("C-PERF-04 a retry releases the lease once the groups exit, without ever recording them", async () => {
  const group = spawnGroup();
  const { path, lease } = await claimedLease("elwood-retain-retry-release-");
  // Every write fails, so the only way out of the loop is the groups exiting.
  const retain = vi.spyOn(owner, "retainProbeOwner").mockRejectedValue(new Error("disk failed"));
  try {
    await retainLease(path, lease, [group.id], 5);
    await expect.poll(() => retain.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(2);
    expect(existsSync(path)).toBe(true); // still held while the group lives
    await group.killGroup();
    // The owner process is still alive, yet the lease ends with the group it was held for.
    await expect.poll(() => existsSync(path), { timeout: 5_000 }).toBe(false);
  } finally {
    retain.mockRestore();
    await group.killGroup();
  }
});
