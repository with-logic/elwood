/**
 * The update lease's owner record: its wire format, the liveness it implies, and the
 * generation-safe write that replaces it (PRD §9.2, C-PERF-04). Process groups here are
 * real, detached, and only ever observed — never signaled.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
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

/** A real process group that outlives this call, plus the means to end it. */
function spawnGroup(): { id: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const id = child.pid as number;
  return {
    id,
    stop: () =>
      new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        process.kill(-id, "SIGKILL");
      }),
  };
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
    await group.stop();
    // This process is still very much alive, so a record that ended with its groups
    // proves liveness follows the groups rather than the writer.
    expect(processGroupGone(group.id)).toBe(true);
    expect(leaseIsAlive(held)).toBe(false);
    expect(leaseIsAlive({ pid: held.pid, token: held.token })).toBe(true);
  } finally {
    if (!processGroupGone(group.id)) await group.stop();
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

test("C-PERF-04 a retained write that cannot be staged reports the failure", async () => {
  // No lease directory, so the pending record cannot be written at all.
  const path = join(tempDir("elwood-owner-unwritable-"), "codex.lock");
  const owner = { pid: process.pid, token: "11111111-2222-3333-4444-555555555555" };
  await expect(retainProbeOwner(path, owner, [4242])).rejects.toThrow();
});
