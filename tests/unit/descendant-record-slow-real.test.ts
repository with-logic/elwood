/**
 * The descendant record against slow real reads (PRD §5.3 and §9.4, C-LIFE-10). On a
 * loaded host one table read, with Codex's daemon path reads, can take over a second, and
 * a read cut short records nothing. With every real `/bin/ps` read started 1.2 s late,
 * the watch still knows the leader's tree, and records the setsid child and grandchild
 * the leader leaves when it exits on SIGTERM.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { watchDescendants } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { osProcessTreeOps } from "../../src/runtime/shutdown/reap-tree.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";

/** How late each read starts: longer than one second, as a read under load can take. */
const SLOW_READ_MS = 1_200;

test("C-LIFE-10 a stop's record knows the leader's tree when each read takes over a second", async () => {
  const tree = startDetachedTree();
  const [child, grandchild] = await detachedDescendantPids(tree);
  const slowReads = {
    listProcesses: async (timeoutMs: number, scope?: DaemonScope) => {
      await sleep(SLOW_READ_MS);
      return osProcessTreeOps.listProcesses(Math.max(1, timeoutMs - SLOW_READ_MS), scope);
    },
  };
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    tree.pty.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const watch = watchDescendants(tree.pty.pid, slowReads, () => exited);
  await watch.firstRead;
  tree.pty.kill("SIGTERM");
  await exit;
  const record = await watch.finish();
  expect(record.known).toBe(true);
  const survivors = record.survivors(await listProcessTable(10_000));
  expect(new Set(survivors.map((row) => row.pid))).toEqual(new Set([child, grandchild]));
}, 30_000);
