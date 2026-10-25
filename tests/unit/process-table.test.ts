/**
 * Process-table parsing and the descendant-group walk behind the detached sweep.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10): a group is selected only when it holds a
 * live descendant of the leader outside the leader's own group, and never the
 * host's group or an id `kill(-pgid)` would misroute.
 */

import { describe, expect, test } from "vitest";
import {
  coalesceUnstarted,
  detachedDescendantGroups,
  listProcessTable,
  listProcessTableShared,
  type ProcessEntry,
  parseProcessTable,
} from "../../src/runtime/shutdown/process-table.ts";

const LEADER = 5000;
const HOST = 4000;

function entry(pid: number, ppid: number, pgid: number, zombie = false): ProcessEntry {
  return { pid, ppid, pgid, zombie };
}

describe("C-LIFE-10 process table", () => {
  test("parses ps rows, flags zombies, and skips anything that is not a row", () => {
    const stdout = [
      "    1     0     1 Ss",
      " 5000  4000  5000 Ss+",
      " 5001  5000  5001 Z",
      "garbage line",
      "",
    ].join("\n");
    expect(parseProcessTable(stdout)).toEqual([
      entry(1, 0, 1),
      entry(LEADER, HOST, LEADER),
      entry(5001, LEADER, 5001, true),
    ]);
  });

  test("lists the real host table, including this process under its parent", async () => {
    const table = await listProcessTable(10_000);
    expect(table.find((row) => row.pid === process.pid)).toMatchObject({ ppid: process.ppid });
  });

  test("rejects when ps cannot finish inside its timeout", async () => {
    await expect(listProcessTable(1)).rejects.toThrow();
  });
});

describe("C-LIFE-10 detached descendant groups", () => {
  test("walks parent pids transitively and keeps only groups outside the leader's", () => {
    const table = [
      entry(HOST, 1, 3999),
      entry(LEADER, HOST, LEADER),
      entry(5001, LEADER, LEADER), // same group: the group reap already covers it
      entry(5002, LEADER, 5002), // setsid hook
      entry(5003, 5002, 5002), // the hook's own child
      entry(5004, 5003, 5004), // a grandchild that made yet another session
      entry(5005, 5001, 5005), // detached child of an in-group child
      entry(6000, 1, 6000), // unrelated process: never selected
      entry(6001, HOST, 6001), // the host's other child: not a leader descendant
    ];
    // Each group maps to the groups of its members' parents: 5004's parent is 5003, in
    // the hook's group, and 5005's parent is in the leader's own group.
    expect(detachedDescendantGroups(table, LEADER, HOST)).toEqual(
      new Map([
        [5002, new Set([LEADER])],
        [5004, new Set([5002])],
        [5005, new Set([LEADER])],
      ]),
    );
  });

  test("a descendant whose own parent already exited is out of reach", () => {
    // The hook exited and its child was reparented to PID 1: no parent pid links it now.
    const table = [entry(LEADER, HOST, LEADER), entry(5004, 1, 5004)];
    expect(detachedDescendantGroups(table, LEADER, HOST).size).toBe(0);
  });

  test("ignores groups whose descendants are all zombies", () => {
    const table = [entry(LEADER, HOST, LEADER), entry(5002, LEADER, 5002, true)];
    expect(detachedDescendantGroups(table, LEADER, HOST).size).toBe(0);
  });

  test("never selects the host's group, the leader's group, or a misrouted id", () => {
    const table = [
      entry(HOST, 1, 3999),
      entry(LEADER, HOST, 4500), // a leader whose group differs from its pid
      entry(5001, LEADER, 4500),
      entry(5002, LEADER, 3999), // impossible in practice: shares the host's group
      entry(5003, LEADER, 1),
      entry(5004, LEADER, 0),
      entry(5005, LEADER, LEADER),
    ];
    expect(detachedDescendantGroups(table, LEADER, HOST).size).toBe(0);
  });

  test("a leader missing from the read still parents its listed children by its pid", () => {
    // `ps` can read a leader's children in the same pass the leader's own row left.
    expect(detachedDescendantGroups([entry(5002, LEADER, 5002)], LEADER, HOST)).toEqual(
      new Map([[5002, new Set([LEADER])]]),
    );
  });

  test("survives a parent-pid cycle", () => {
    const table = [
      entry(LEADER, HOST, LEADER),
      entry(5002, LEADER, 5002),
      entry(LEADER, 5002, LEADER), // a duplicate row closing a cycle back to the leader
    ];
    expect(detachedDescendantGroups(table, LEADER, HOST)).toEqual(
      new Map([[5002, new Set([LEADER])]]),
    );
  });
});

describe("C-LIFE-10 coalesced process listing", () => {
  test("requests made before a listing starts share it, with the smallest timeout", async () => {
    const runs: number[] = [];
    const list = coalesceUnstarted((timeoutMs) => {
      runs.push(timeoutMs);
      return Promise.resolve(runs.length);
    });
    const joined = [list(3_000), list(1_200), list(2_000)];
    expect(runs).toEqual([]); // nothing starts in the requesting turn
    expect(await Promise.all(joined)).toEqual([1, 1, 1]);
    expect(runs).toEqual([1_200]);
  });

  test("a request after its listing started gets a fresh one", async () => {
    let runs = 0;
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const list = coalesceUnstarted(async () => {
      runs += 1;
      const run = runs;
      await release;
      return run;
    });
    const first = list(1_000);
    await new Promise((settled) => setImmediate(settled)); // the first listing starts
    const second = list(1_000);
    resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
  });

  test("the production listing reads the real host table", async () => {
    const table = await listProcessTableShared(10_000);
    expect(table.some((row) => row.pid === process.pid)).toBe(true);
  });
});
