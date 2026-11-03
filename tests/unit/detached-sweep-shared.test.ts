/**
 * The detached walk never follows Codex's shared app-server daemon (PRD §5.3 and §9.4,
 * C-LIFE-10): a process a read marks `shared`, and everything under it, is neither stopped
 * nor killed, and every read of one walk marks within the same scope, rooted at the leader
 * and each group the walk stopped. Scripted tables only.
 */

import { describe, expect, test } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { detachedDescendantGroups } from "../../src/runtime/shutdown/process-table.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import {
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

describe("C-LIFE-10 the walk and Codex's shared daemon", () => {
  test("never follows a daemon, nor anything it started", () => {
    const rows = [
      leaderRow,
      hook(5002),
      hook(5010, { name: "codex", shared: true }),
      hook(5011, { ppid: 5010, name: "codex-code-mode-", shared: true }),
      hook(5012, { ppid: 5010, pgid: 5010, name: "node" }),
      hook(5013, { ppid: 5012 }),
      hook(5014, { ppid: 5002, name: "codex", shared: true }), // one a hook started
      hook(5015, { ppid: 5014 }),
    ];
    expect(detachedDescendantGroups(rows, { leaderPid: LEADER, hostPid: process.pid })).toEqual(
      new Map([[5002, new Set([leaderRow])]]),
    );
  });

  test("stops and kills a hook, but never a daemon or what it started", async () => {
    const daemon = hook(5010, { name: "codex", shared: true });
    const { ops, calls } = scripted([[leaderRow, hook(5002), daemon, hook(5011, { ppid: 5010 })]]);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5002, list, list, kill 5002");
  });

  test("every read passes one scope, rooted at the leader and each group stopped", async () => {
    const { ops } = scripted([[leaderRow, hook(5002)]]);
    const scopes: unknown[] = [];
    const listProcesses = (timeoutMs: number, scope?: DaemonScope) => {
      scopes.push(scope);
      return ops.listProcesses(timeoutMs);
    };
    const sweep = sweepDetachedGroups(LEADER, { ...ops, listProcesses }, leaderNeverExits, 3_000);
    expect(await sweep).toBeUndefined();
    expect(scopes.length).toBeGreaterThan(1);
    expect(new Set(scopes)).toEqual(new Set([scopes[0]]));
    expect(scopes[0]).toEqual({ roots: new Set([LEADER, 5002]), known: new Set() });
  });
});
