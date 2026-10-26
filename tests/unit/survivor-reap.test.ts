/**
 * The reap of the recorded detached descendants that outlive a PTY leader's graceful
 * exit (PRD §5.3 and §9.4, C-LIFE-10): which groups it stops, how it holds them, the
 * order it kills them in, and how it fails. Injected process operations only — no real
 * group is signaled here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  ticking,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A setsid hook (5002) and its child (5003) in its group, as the leader's last read showed. */
const recorded = () => {
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })], LEADER);
  return record;
};
/** The same two after the leader's exit reparented the hook to PID 1. */
const orphaned: readonly ProcessEntry[] = [
  hook(5002, { ppid: 1 }),
  hook(5003, { ppid: 5002, pgid: 5002 }),
];

const refusingStop = {
  stopGroup: () => {
    throw errno("EPERM");
  },
};

describe("C-LIFE-10 reaping a graceful stop's surviving descendants", () => {
  test("stops a recorded group, holds it over two reads, then kills it", async () => {
    const { ops, calls } = scripted([orphaned]);
    const scopes: unknown[] = [];
    const listProcesses = (timeoutMs: number, scope?: DaemonScope) => {
      scopes.push(scope); // Each read marks Codex's daemon among the recorded processes.
      return ops.listProcesses(timeoutMs);
    };
    const reap = reapRecordedSurvivors(recorded(), { ...ops, listProcesses });
    await expect(reap).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("list, stop 5002, list, list, kill 5002");
    expect(scopes).toHaveLength(3);
    expect(new Set(scopes)).toEqual(new Set([scopes[0]]));
    expect(scopes[0]).toMatchObject({ roots: new Set([5002, 5003]) });
  });

  test("a recorded process gone, or its pid now another process's, is left alone", async () => {
    const reused = hook(5002, { ppid: 1, startedAt: "Sun Oct 25 22:00:09 2026" });
    const { ops, calls } = scripted([[reused]]);
    await expect(reapRecordedSurvivors(recorded(), ops)).resolves.toBeUndefined();
    expect(calls).toEqual(["list"]);
  });

  test("a group a held survivor started after the last recording read is killed first", async () => {
    const { ops, calls } = scripted([[...orphaned, hook(5010, { ppid: 5002 })]]);
    await expect(reapRecordedSurvivors(recorded(), ops)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "list, stop 5002, list, list, stop 5010, list, list, kill 5010, kill 5002",
    );
  });

  test("stops a recorded group again for a member its first stop missed", async () => {
    const late = hook(5004, { ppid: 5002, pgid: 5002 });
    const { ops, calls } = scripted(
      [[hook(5002, { ppid: 1 })], [hook(5002, { ppid: 1 }), late]],
      {},
      new Set([5004]),
    );
    await expect(reapRecordedSurvivors(recorded(), ops)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("list, stop 5002, list, stop 5002, list, list, kill 5002");
  });

  test("never signals the host's group or an id kill(-pgid) would misroute", async () => {
    const host = process.pid;
    const record = new DescendantRecord();
    record.observe([leaderRow, hook(5002), hook(5003), hook(5004)], LEADER);
    const table = [
      { ...hook(host, { ppid: 1 }), pgid: 7000 },
      hook(5002, { ppid: 1, pgid: 7000 }),
      hook(5003, { ppid: 1, pgid: 1 }),
      hook(5004, { ppid: 1, pgid: 0 }),
    ];
    const { ops, calls } = scripted([table]);
    await expect(reapRecordedSurvivors(record, ops)).resolves.toBeUndefined();
    expect(calls).toEqual(["list"]);
  });

  test("an empty record reads and signals nothing, whatever else the table holds", async () => {
    // A leader whose reads showed no descendant: every detached process on the host,
    // orphans under PID 1 included, belongs to something else.
    const record = new DescendantRecord();
    record.observe([leaderRow], LEADER);
    const { ops, calls } = scripted([[...orphaned, hook(6000, { ppid: 1 }), hook(1, { ppid: 0 })]]);
    await expect(reapRecordedSurvivors(record, ops)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a record that does not know the leader's tree fails, naming no group", async () => {
    const { ops, calls } = scripted([orphaned]);
    const failure = await reapRecordedSurvivors(new DescendantRecord(), ops);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: no read showed the leader's tree",
    );
    expect(failure?.processGroupIds).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an unreadable table fails against the groups not yet held, which are still killed", async () => {
    const { ops, calls } = scripted([orphaned], {
      listProcesses: () => {
        calls.push("list");
        if (calls.length > 2) return Promise.reject(errno("EAGAIN"));
        return Promise.resolve([hook(5002, { ppid: 1 })]);
      },
    });
    const failure = await reapRecordedSurvivors(recorded(), ops);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: process table unreadable (EAGAIN)",
    );
    expect(failure?.processGroupIds).toEqual([5002]);
    expect(calls.join(", ")).toBe("list, stop 5002, list, kill 5002");
  });

  test("a group never held by the deadline fails, and is still killed", async () => {
    const timeouts: number[] = [];
    const listProcesses = (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      return Promise.resolve([hook(5002, { ppid: 1 })]);
    };
    const run = scripted([], { listProcesses });
    const failure = await reapRecordedSurvivors(recorded(), ticking(run.ops), 250);
    expect(timeouts).toEqual([250, 150, 50]); // Each read gets what is left of the deadline.
    expect(failure?.message).toBe(
      "Could not reap detached descendants: process groups not confirmed stopped by the deadline",
    );
    expect(failure?.processGroupIds).toEqual([5002]);
    expect(run.calls.at(-1)).toBe("kill 5002");
  });

  test("a recorded group that refuses its stop fails while it lives", async () => {
    const { ops, calls } = scripted([orphaned], refusingStop);
    const failure = await reapRecordedSurvivors(recorded(), ops);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
    );
    expect(failure?.processGroupIds).toEqual([5002]);
    expect(calls).toEqual(["list", "list"]);
  });

  test("a group that refused its stop and then exited is not a failure", async () => {
    const { ops } = scripted([orphaned, []], refusingStop);
    await expect(reapRecordedSurvivors(recorded(), ops)).resolves.toBeUndefined();
  });
});
