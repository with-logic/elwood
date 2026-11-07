/**
 * The record a graceful `stop()` keeps of a PTY leader's detached descendants while it
 * waits for the leader to exit (PRD §5.3 and §9.4, C-LIFE-10): what a read records, how
 * pid and start time keep a reused pid out, and how the reads repeat until the exit.
 * Scripted process tables only; nothing is signaled.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import {
  RECORD_INTERVAL_MS,
  RECORD_READ_MS,
  watchDescendants,
} from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import { hook, LEADER, leaderRow, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();

afterEach(() => {
  vi.useRealTimers();
});

const LATER = "Sun Oct 25 22:00:09 2026";
/** A setsid hook (5002) with a child in its group (5003), and a child in the leader's group. */
const tree = [
  leaderRow,
  hook(5001, { pgid: LEADER }),
  hook(5002),
  hook(5003, { ppid: 5002, pgid: 5002 }),
];
const pids = (rows: readonly ProcessEntry[]) => rows.map((row) => row.pid);

/** Ops that serve `tables` in turn (the last repeats) and log each read's bound and scope. */
function reads(tables: readonly (readonly ProcessEntry[] | Error)[]) {
  const timeouts: number[] = [];
  const scopes: unknown[] = [];
  return {
    timeouts,
    scopes,
    listProcesses: (timeoutMs: number, scope?: DaemonScope) => {
      timeouts.push(timeoutMs);
      scopes.push(scope);
      const table = tables[Math.min(timeouts.length, tables.length) - 1] ?? [];
      return table instanceof Error ? Promise.reject(table) : Promise.resolve(table);
    },
  };
}

describe("C-LIFE-10 a graceful stop's descendant record", () => {
  test("records each detached group's live members, never the leader's own group", () => {
    const record = new DescendantRecord();
    record.observeFirst(tree, LEADER, Date.now());
    record.observe([...tree, hook(5004, { zombie: true })], LEADER);
    expect(record.known).toBe(true);
    expect(pids(record.survivors([...tree, hook(5004)]))).toEqual([5002, 5003]);
  });

  test("a recorded pid is a survivor only while its start time matches", () => {
    const record = new DescendantRecord();
    record.observeFirst(tree, LEADER, Date.now());
    record.observe(tree, LEADER);
    const after = [hook(5002, { ppid: 1, startedAt: LATER }), hook(5003, { ppid: 1 })];
    expect(pids(record.survivors(after))).toEqual([5003]);
    expect(record.survivors([hook(5003, { ppid: 1, zombie: true })])).toEqual([]);
  });

  test("a recorded process that has since become Codex's shared daemon is no survivor", () => {
    // Started by the TUI, recorded before it exec'd the daemon: same pid, same start.
    const record = new DescendantRecord();
    record.observeFirst(tree, LEADER, Date.now());
    record.observe(tree, LEADER);
    const after = [hook(5002, { ppid: 1, name: "codex", shared: true }), hook(5003)];
    expect(pids(record.survivors(after))).toEqual([5003]);
  });

  test("a read after the signal that does not show the leader live leaves its tree unknown", () => {
    const record = new DescendantRecord();
    record.observe([{ ...leaderRow, zombie: true }, hook(5002)], LEADER);
    record.observe([hook(5002)], LEADER);
    expect(record.known).toBe(false);
    expect(record.survivors(tree)).toEqual([]);
    record.observeFirst(tree, LEADER, Date.now());
    record.observe(tree, LEADER);
    expect(record.known).toBe(true);
    record.observe([hook(5002)], LEADER); // A later read without it adds nothing, loses nothing.
    expect(record.known).toBe(true);
  });

  test("a leader gone by the read before the signal left nothing linked, nor does its pid", () => {
    const record = new DescendantRecord();
    record.observeFirst([{ ...leaderRow, zombie: true }, hook(5002)], LEADER, Date.now());
    expect(record.known).toBe(true);
    record.observe(tree, LEADER); // Its pid, read again, is not the leader the stop was for.
    expect(record.survivors(tree)).toEqual([]);
  });

  test("a leader pid that starts again is another process, so its tree is not recorded", () => {
    const record = new DescendantRecord();
    record.observeFirst([leaderRow], LEADER, Date.now());
    record.observe([leaderRow], LEADER);
    record.observe([{ ...leaderRow, startedAt: LATER }, hook(5002)], LEADER);
    expect(record.survivors(tree)).toEqual([]);
    record.observe(tree, LEADER);
    expect(pids(record.survivors(tree))).toEqual([5002, 5003]);
  });

  test("a new record knows nothing", () => {
    expect(new DescendantRecord().known).toBe(false);
  });
});

describe("C-LIFE-10 a graceful stop's descendant watch", () => {
  test("reads until the leader's exit is observed, recording what each read shows", async () => {
    vi.useFakeTimers();
    let exited = false;
    const ops = reads([[leaderRow], tree, [{ ...leaderRow, stopped: true }]]);
    const watch = watchDescendants(LEADER, ops, () => exited);
    await watch.firstRead;
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
    await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 2);
    exited = true;
    const record = await watch.finish();
    const count = ops.timeouts.length;
    expect(pids(record.survivors(tree))).toEqual([LEADER, 5001, 5002, 5003]);
    await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS);
    expect(ops.timeouts.length).toBe(count);
    expect(new Set(ops.timeouts)).toEqual(new Set([RECORD_READ_MS]));
    // Each read marks Codex's shared daemon under the leader, so it is never recorded.
    expect(new Set(ops.scopes)).toEqual(new Set([ops.scopes[0]]));
    expect(ops.scopes[0]).toMatchObject({ roots: new Set([LEADER]) });
  });

  test("a failed first read permanently refuses a later replacement baseline", async () => {
    const ops = reads([new Error("ps failed"), tree]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    const record = await watch.finish();
    record.observe(tree, LEADER); // Even a direct later read cannot establish authority.
    expect(record.known).toBe(false);
    expect(record.survivors(tree)).toEqual([]);
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
  });

  test("a failed later read retains the baseline and the next read follows", async () => {
    vi.useFakeTimers();
    const ops = reads([[leaderRow], new Error("ps failed"), tree]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 2);
    expect(pids((await watch.finish()).survivors(tree))).toEqual([LEADER, 5001, 5002, 5003]);
  });

  test("an exit seen while waiting between reads ends the watch without another read", async () => {
    vi.useFakeTimers();
    let exited = false;
    const ops = reads([tree]);
    const watch = watchDescendants(LEADER, ops, () => exited);
    await watch.firstRead;
    try {
      expect(vi.getTimerCount()).toBe(1);
      exited = true;
      await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS);
      expect(ops.timeouts).toEqual([RECORD_READ_MS]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      expect((await watch.finish()).known).toBe(true);
    }
  });

  test("finish ends the wait between reads at once, without another read", async () => {
    vi.useFakeTimers(); // A caller's fake timers would hold that wait forever.
    const ops = reads([tree]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    expect((await watch.finish()).known).toBe(true);
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
  });

  test("a leader already exited when the watch starts is read once", async () => {
    const ops = reads([tree]);
    const record = await watchDescendants(LEADER, ops, () => true).finish();
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
    expect(record.known).toBe(true);
  });
});
