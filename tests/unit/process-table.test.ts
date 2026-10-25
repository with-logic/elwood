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
  type ProcessEntry,
  parseProcessTable,
} from "../../src/runtime/shutdown/process-table.ts";

const LEADER = 5000;
const HOST = 4000;

type Row = { readonly pid: number; readonly ppid: number; readonly pgid: number };

function row({ pid, ppid, pgid }: Row, state: "Z" | "T" | "S" = "S"): ProcessEntry {
  return { pid, ppid, pgid, zombie: state === "Z", stopped: state === "T" };
}

const leaderRow = row({ pid: LEADER, ppid: HOST, pgid: LEADER });

const walk = (table: readonly ProcessEntry[]) =>
  detachedDescendantGroups(table, { leaderPid: LEADER, hostPid: HOST });

describe("C-LIFE-10 process table", () => {
  test("parses ps rows, flags zombies and stopped rows, and skips non-rows", () => {
    const stdout = [
      "    1     0     1 Ss",
      " 5000  4000  5000 Ss+",
      " 5001  5000  5001 Z",
      " 5002  5000  5002 T+",
      "garbage line",
      "",
    ].join("\n");
    expect(parseProcessTable(stdout)).toEqual([
      row({ pid: 1, ppid: 0, pgid: 1 }),
      leaderRow,
      row({ pid: 5001, ppid: LEADER, pgid: 5001 }, "Z"),
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }, "T"),
    ]);
  });

  test("runs /bin/ps with its timeout, a 16 MiB output cap, and SIGKILL", async () => {
    const runs: unknown[] = [];
    const table = await listProcessTable(1_234, (file, args, options) => {
      runs.push({ file, args, options });
      return Promise.resolve({ stdout: " 5000  4000  5000 S\n" });
    });
    expect(table).toEqual([leaderRow]);
    expect(runs).toEqual([
      {
        file: "/bin/ps",
        args: ["-A", "-o", "pid=,ppid=,pgid=,stat="],
        options: { timeout: 1_234, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
      },
    ]);
  });
});

describe("C-LIFE-10 detached descendant groups", () => {
  test("walks parent pids transitively and keeps only groups outside the leader's", () => {
    const inGroupChild = row({ pid: 5001, ppid: LEADER, pgid: LEADER });
    const hooksChild = row({ pid: 5003, ppid: 5002, pgid: 5002 }, "T");
    const table = [
      row({ pid: HOST, ppid: 1, pgid: 3999 }),
      leaderRow,
      inGroupChild, // same group: the group reap already covers it
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }), // setsid hook
      hooksChild, // the hook's own child, read stopped
      row({ pid: 5004, ppid: 5003, pgid: 5004 }), // a grandchild that made yet another session
      row({ pid: 5005, ppid: 5001, pgid: 5005 }), // detached child of an in-group child
      row({ pid: 6000, ppid: 1, pgid: 6000 }), // unrelated process: never selected
      row({ pid: 6001, ppid: HOST, pgid: 6001 }), // the host's other child: not a leader descendant
    ];
    // Each group maps to its members' parents that sit in other groups, as read: 5003's
    // parent shares its group and adds nothing, 5004's parent is 5003 in the hook's
    // group, and 5005's parent is 5001 in the leader's own group.
    expect(walk(table)).toEqual(
      new Map([
        [5002, new Set([leaderRow])],
        [5004, new Set([hooksChild])],
        [5005, new Set([inGroupChild])],
      ]),
    );
  });

  test("a descendant whose own parent already exited is out of reach", () => {
    // The hook exited and its child was reparented to PID 1: no parent pid links it now.
    const table = [leaderRow, row({ pid: 5004, ppid: 1, pgid: 5004 })];
    expect(walk(table).size).toBe(0);
  });

  test("ignores groups whose descendants are all zombies", () => {
    const table = [leaderRow, row({ pid: 5002, ppid: LEADER, pgid: 5002 }, "Z")];
    expect(walk(table).size).toBe(0);
  });

  test("never selects the host's group, the leader's group, or a misrouted id", () => {
    const table = [
      row({ pid: HOST, ppid: 1, pgid: 3999 }),
      row({ pid: LEADER, ppid: HOST, pgid: 4500 }), // a leader whose group differs from its pid
      row({ pid: 5001, ppid: LEADER, pgid: 4500 }),
      row({ pid: 5002, ppid: LEADER, pgid: 3999 }), // impossible in practice: shares the host's group
      row({ pid: 5003, ppid: LEADER, pgid: 1 }),
      row({ pid: 5004, ppid: LEADER, pgid: 0 }),
      row({ pid: 5005, ppid: LEADER, pgid: LEADER }),
    ];
    expect(walk(table).size).toBe(0);
  });

  test("a leader missing from the read still parents its children, as a row not stopped", () => {
    // `ps` can read a leader's children in the same pass the leader's own row left.
    const unread = { pid: LEADER, ppid: 0, pgid: LEADER, zombie: false, stopped: false };
    expect(walk([row({ pid: 5002, ppid: LEADER, pgid: 5002 })])).toEqual(
      new Map([[5002, new Set([unread])]]),
    );
  });

  test("survives a parent-pid cycle", () => {
    const table = [
      leaderRow,
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }),
      row({ pid: LEADER, ppid: 5002, pgid: LEADER }), // a duplicate row closing a cycle back to the leader
    ];
    expect(walk(table)).toEqual(new Map([[5002, new Set([leaderRow])]]));
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
});
