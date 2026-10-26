/**
 * The record a graceful `stop()` keeps of a PTY leader's detached descendants while it
 * waits for the leader to exit (PRD §5.3 and §9.4, C-LIFE-10): what a read records, how
 * pid and start time keep a reused pid out, and how the reads repeat until the exit.
 * Scripted process tables only; nothing is signaled.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DescendantRecord,
  RECORD_READ_MS,
  watchDescendants,
} from "../../src/runtime/shutdown/detached-sweep/record.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import { hook, LEADER, leaderRow } from "../helpers/scripted-process-tree.ts";

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
    record.observe([...tree, hook(5004, { zombie: true })], LEADER);
    expect(record.observed).toBe(true);
    expect(pids(record.survivors([...tree, hook(5004)]))).toEqual([5002, 5003]);
  });

  test("a recorded pid is a survivor only while its start time matches", () => {
    const record = new DescendantRecord();
    record.observe(tree, LEADER);
    const after = [hook(5002, { ppid: 1, startedAt: LATER }), hook(5003, { ppid: 1 })];
    expect(pids(record.survivors(after))).toEqual([5003]);
    expect(record.survivors([hook(5003, { ppid: 1, zombie: true })])).toEqual([]);
  });

  test("a recorded process that has since become Codex's shared daemon is no survivor", () => {
    // Started by the TUI, recorded before it exec'd the daemon: same pid, same start.
    const record = new DescendantRecord();
    record.observe(tree, LEADER);
    const after = [hook(5002, { ppid: 1, name: "codex", shared: true }), hook(5003)];
    expect(pids(record.survivors(after))).toEqual([5003]);
  });

  test("a read that does not show the leader live records nothing, but counts as a read", () => {
    const record = new DescendantRecord();
    record.observe([{ ...leaderRow, zombie: true }, hook(5002)], LEADER);
    record.observe([hook(5002)], LEADER);
    expect(record.observed).toBe(true);
    expect(record.survivors(tree)).toEqual([]);
  });

  test("a leader pid that starts again is another process, so its tree is not recorded", () => {
    const record = new DescendantRecord();
    record.observe([leaderRow], LEADER);
    record.observe([{ ...leaderRow, startedAt: LATER }, hook(5002)], LEADER);
    expect(record.survivors(tree)).toEqual([]);
    record.observe(tree, LEADER);
    expect(pids(record.survivors(tree))).toEqual([5002, 5003]);
  });

  test("a new record has seen nothing", () => {
    expect(new DescendantRecord().observed).toBe(false);
  });
});

describe("C-LIFE-10 a graceful stop's descendant watch", () => {
  test("reads until the leader's exit is observed, recording what each read shows", async () => {
    let exited = false;
    const ops = reads([[leaderRow], tree, [{ ...leaderRow, stopped: true }]]);
    const watch = watchDescendants(LEADER, ops, () => exited);
    await watch.firstRead;
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
    while (ops.timeouts.length < 3) await new Promise((resolve) => setImmediate(resolve));
    exited = true;
    const record = await watch.finish();
    const count = ops.timeouts.length;
    expect(pids(record.survivors(tree))).toEqual([5002, 5003]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ops.timeouts.length).toBe(count);
    expect(new Set(ops.timeouts)).toEqual(new Set([RECORD_READ_MS]));
    // Each read marks Codex's shared daemon under the leader, so it is never recorded.
    expect(new Set(ops.scopes)).toEqual(new Set([ops.scopes[0]]));
    expect(ops.scopes[0]).toMatchObject({ roots: new Set([LEADER]) });
  });

  test("a failed read records nothing and the next read follows", async () => {
    const ops = reads([new Error("ps failed"), tree]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    while (ops.timeouts.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const record = await watch.finish();
    expect(pids(record.survivors(tree))).toEqual([5002, 5003]);
  });

  test("a watch whose every read failed has observed nothing", async () => {
    const ops = reads([new Error("ps failed")]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    const record = await watch.finish();
    expect(record.observed).toBe(false);
  });

  test("finish ends the wait between reads at once, without another read", async () => {
    vi.useFakeTimers(); // A caller's fake timers would hold that wait forever.
    const ops = reads([tree]);
    const watch = watchDescendants(LEADER, ops, () => false);
    await watch.firstRead;
    expect((await watch.finish()).observed).toBe(true);
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
  });

  test("a leader already exited when the watch starts is read once", async () => {
    const ops = reads([tree]);
    const record = await watchDescendants(LEADER, ops, () => true).finish();
    expect(ops.timeouts).toEqual([RECORD_READ_MS]);
    expect(record.observed).toBe(true);
  });
});
