/**
 * The descendant record against slow real reads (PRD §5.3 and §9.4, C-LIFE-10). On a
 * loaded host one table read, with Codex's daemon path reads, can take over a second, and
 * a read cut short records nothing. With every real `/bin/ps` read started 1.2 s late,
 * the watch still knows the leader's tree, and records the setsid child and grandchild
 * the leader leaves when it exits on SIGTERM.
 */

import { expect, test } from "vitest";
import { watchDescendants } from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { lateRealReads } from "../helpers/table-reads.ts";

/** How late each read starts: longer than one second, as a read under load can take. */
const SLOW_READ_MS = 1_200;

test("C-LIFE-10 a stop's record knows the leader's tree when each read takes over a second", async () => {
  const tree = startDetachedTree();
  const [child, grandchild] = await detachedDescendantPids(tree);
  const slowReads = { listProcesses: lateRealReads(SLOW_READ_MS) };
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
