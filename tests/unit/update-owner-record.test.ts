/**
 * The update lease's owner record: its wire format, the liveness it implies, and the
 * generation-safe write that replaces it (PRD §9.2, C-PERF-04). Process groups here are
 * real and detached. Production liveness code only ever observes a group; the signalling
 * below is this test disposing of the fixture group it created.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { processGroupGone } from "../../src/runtime/probe-cleanup.ts";
import {
  leaseIsAlive,
  ownerFile,
  pendingOwnerPrefix,
  readOwner,
  retainProbeOwner,
  serializeOwner,
} from "../../src/runtime/update/owner.ts";
import { tempDir } from "../helpers/tmp.ts";

/**
 * A real process group that outlives this call, plus the means to end it. `killGroup` waits
 * for the group to stop being observable rather than for the child's `close` event: reaping
 * is not instantaneous, and a transient `EPERM` counts as live by design, so polling the
 * same predicate production uses is what avoids a macOS-only race.
 */
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

function writeRecord(path: string, contents: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ownerFile), contents);
}

test("C-PERF-04 an owner record round-trips with and without owning process groups", async () => {
  const path = join(tempDir("elwood-owner-record-"), "codex.lock");
  const plain = { pid: 4321, token: "11111111-2222-3333-4444-555555555555" };
  writeRecord(path, serializeOwner(plain));
  expect(await readOwner(path)).toEqual(plain);
  const held = { ...plain, ownedProcessGroupIds: [22, 333] };
  writeRecord(path, serializeOwner(held));
  expect(await readOwner(path)).toEqual(held);
  // The group list is an optional suffix, so an older version's record still parses.
  expect(serializeOwner(plain)).toBe("4321:11111111-2222-3333-4444-555555555555");
});

test.each([
  ["not a record", "nonsense"],
  ["a zero pid", "0:11111111-2222-3333-4444-555555555555"],
  ["a negative pid", "-1:11111111-2222-3333-4444-555555555555"],
  ["a zero group", "4321:11111111-2222-3333-4444-555555555555:0"],
  ["a group that is not a number", "4321:11111111-2222-3333-4444-555555555555:x"],
  // `process.kill(-1, 0)` is the broadcast target, so a record naming group 1 would look
  // alive while this user owns any process at all and hold the lease forever.
  ["the broadcast group", "4321:11111111-2222-3333-4444-555555555555:1"],
  ["a broadcast group among valid ones", "4321:11111111-2222-3333-4444-555555555555:222,1"],
])("C-PERF-04 a record naming %s is unreadable rather than live", async (_name, contents) => {
  const path = join(tempDir("elwood-owner-invalid-"), "codex.lock");
  writeRecord(path, contents);
  // Unreadable fails safe elsewhere; what matters here is that no id reaches process.kill.
  expect(await readOwner(path)).toBeUndefined();
});

test("C-PERF-04 a record naming groups is alive while any group is, not while its writer is", async () => {
  const group = spawnGroup();
  try {
    const held = {
      pid: process.pid,
      token: "11111111-2222-3333-4444-555555555555",
      ownedProcessGroupIds: [group.id],
    };
    expect(processGroupGone(group.id)).toBe(false);
    expect(leaseIsAlive(held)).toBe(true);
    await group.killGroup();
    // This process is still very much alive, so a record that ended with its groups
    // proves liveness follows the groups rather than the writer.
    expect(processGroupGone(group.id)).toBe(true);
    expect(leaseIsAlive(held)).toBe(false);
    expect(leaseIsAlive({ pid: held.pid, token: held.token })).toBe(true);
  } finally {
    await group.killGroup();
  }
});

test("C-PERF-04 retaining groups commits into this generation and leaves no pending record", async () => {
  const path = join(tempDir("elwood-owner-retain-"), "codex.lock");
  const owner = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  writeRecord(path, serializeOwner(owner));
  await retainProbeOwner(path, owner, [4242]);
  expect(await readOwner(path)).toEqual({ ...owner, ownedProcessGroupIds: [4242] });
  expect(readdirSync(path)).toEqual([ownerFile]);
});

test("C-PERF-04 a retained write cannot replace a successor generation's record", async () => {
  const path = join(tempDir("elwood-owner-successor-"), "codex.lock");
  const previous = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  const successor = { pid: process.pid, token: "99999999-8888-7777-6666-555555555555" };
  writeRecord(path, serializeOwner(successor));
  await expect(retainProbeOwner(path, previous, [4242])).rejects.toThrow(/another generation/);
  // The successor's record is untouched, and the rejected write left nothing behind.
  expect(readFileSync(join(path, ownerFile), "utf8")).toBe(serializeOwner(successor));
  expect(readdirSync(path).filter((entry) => entry.startsWith(pendingOwnerPrefix))).toEqual([]);
});

test.each([
  ["no groups at all", [] as readonly number[]],
  ["the broadcast group", [1]],
  ["a zero group", [0]],
  ["a fractional group", [12.5]],
])("C-PERF-04 retention refuses %s rather than publishing it", async (_name, groups) => {
  const path = join(tempDir("elwood-owner-refuse-"), "codex.lock");
  const owner = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  writeRecord(path, serializeOwner(owner));
  await expect(retainProbeOwner(path, owner, groups)).rejects.toThrow(/valid process groups/);
  // The lease still names its owner and is therefore still releasable. Publishing any of
  // these would have made the record unreadable, and an unreadable record fails safe
  // forever: no contender would touch it and its owner could no longer release it.
  expect(await readOwner(path)).toEqual(owner);
  expect(readdirSync(path)).toEqual([ownerFile]);
});

test("C-PERF-04 a retained write that cannot be staged reports the failure", async () => {
  // No lease directory, so the pending record cannot be written at all.
  const path = join(tempDir("elwood-owner-unwritable-"), "codex.lock");
  const owner = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  await expect(retainProbeOwner(path, owner, [4242])).rejects.toThrow();
});

test("C-PERF-04 a group this user may not signal counts as live, not gone", () => {
  // Only ESRCH proves absence. Treating a group we merely cannot inspect as gone would
  // release the lease under a live updater and let a second installer run against it.
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  try {
    expect(processGroupGone(4242)).toBe(false);
  } finally {
    kill.mockRestore();
  }
});
