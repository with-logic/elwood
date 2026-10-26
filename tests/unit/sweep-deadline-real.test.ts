/**
 * The detached walk's deadline against slow real reads (PRD §5.3, C-LIFE-10). On a loaded
 * host one process-table read can take over half a second, and a setsid hook with a
 * setsid child of its own takes six reads. With every real `/bin/ps` read started 600 ms
 * late, `kill` still reaps such a tree within the deadline.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { pollGone } from "../helpers/process-liveness.ts";

/** How late each read starts: about what one read took on a loaded host. */
const SLOW_READ_MS = 600;

test("C-LIFE-10 kill reaps a setsid hook and its setsid child when each read takes 600 ms", async () => {
  const tree = startDetachedTree();
  const [child, grandchild] = await detachedDescendantPids(tree);
  let reads = 0;
  const slowReads = {
    ...osProcessTreeOps,
    listProcesses: async (timeoutMs: number) => {
      reads += 1;
      await sleep(SLOW_READ_MS);
      return osProcessTreeOps.listProcesses(Math.max(1, timeoutMs - SLOW_READ_MS));
    },
  };
  await terminatePty(tree.pty, "SIGKILL", new SessionReaper(tree.pty.pid, slowReads));
  // Two reads hold the leader's group, and two more each level of setsid nesting.
  expect(reads).toBeGreaterThanOrEqual(6);
  expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
  expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
}, 30_000);
