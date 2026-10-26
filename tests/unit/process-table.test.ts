/**
 * Process-table parsing and the descendant-group walk behind the detached sweep.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10): a group is selected only when it holds a
 * live descendant of the leader outside the leader's own group, and never the
 * host's group or an id `kill(-pgid)` would misroute.
 */

import { describe, expect, test, vi } from "vitest";
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

function row({ pid, ppid, pgid }: Row, state: "Z" | "T" | "S" = "S", name = "sh") {
  const flags = { zombie: state === "Z", stopped: state === "T" };
  return { pid, ppid, pgid, ...flags, name, shared: false };
}

const leaderRow = row({ pid: LEADER, ppid: HOST, pgid: LEADER });

const walk = (table: readonly ProcessEntry[]) =>
  detachedDescendantGroups(table, { leaderPid: LEADER, hostPid: HOST });

describe("C-LIFE-10 process table", () => {
  test("runs /bin/ps with its timeout, a 16 MiB output cap, and SIGKILL, and parses its rows", async () => {
    const stdout = [
      " 5000  4000  5000 Ss+  sh                5000",
      " 5001  5000  5001 Z                      5001",
      " 5002  5000  5002 T+   Google Chrome He  5002",
      "",
    ].join("\n");
    const runs: unknown[] = [];
    const table = await listProcessTable(1_234, (file, args, options) => {
      runs.push({ file, args, options });
      return Promise.resolve({ stdout });
    });
    expect(table).toEqual([
      leaderRow,
      row({ pid: 5001, ppid: LEADER, pgid: 5001 }, "Z", ""),
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }, "T", "Google Chrome He"),
    ]);
    expect(runs).toEqual([
      {
        file: "/bin/ps",
        args: ["-A", "-o", "pid=,ppid=,pgid=,stat=,ucomm=,pid="],
        options: { timeout: 1_234, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
      },
    ]);
  });

  test("rejects a read with any line that is not one whole row", () => {
    for (const line of [
      " 5000  4000  5000 S    sh",
      " 5000  4000  5000 S    sh  5001",
      "69992 69991 69988 S    a\n1 5000 1 S    69992", // `ps` prints a name with a newline raw
      "6000 1 6000 S sh 6000", // a pid read twice
    ]) {
      expect(() => parseProcessTable(`6000 1 6000 S sh 6000\n${line}`)).toThrow("one whole row");
    }
  });
});

describe("C-LIFE-10 detached descendant groups", () => {
  test("walks parent pids transitively and keeps only groups outside the leader's", () => {
    const inGroupChild = row({ pid: 5001, ppid: LEADER, pgid: LEADER });
    const hookChild = row({ pid: 5003, ppid: 5002, pgid: 5002 }, "T");
    const table = [
      row({ pid: HOST, ppid: 1, pgid: 3999 }),
      leaderRow,
      inGroupChild, // same group: the group reap already covers it
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }), // setsid hook
      hookChild, // the hook's own child, read stopped
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
        [5004, new Set([hookChild])],
        [5005, new Set([inGroupChild])],
      ]),
    );
  });

  test("a group keeps every parent row it has in another group", () => {
    // 5006 joined the hook's group from under an in-group child of the leader, so the
    // hook's group has two parents outside it: the leader and that child.
    const inGroupChild = row({ pid: 5001, ppid: LEADER, pgid: LEADER });
    const table = [
      leaderRow,
      inGroupChild,
      row({ pid: 5002, ppid: LEADER, pgid: 5002 }),
      row({ pid: 5006, ppid: 5001, pgid: 5002 }),
    ];
    expect(walk(table)).toEqual(new Map([[5002, new Set([leaderRow, inGroupChild])]]));
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
    const unread = row({ pid: LEADER, ppid: 0, pgid: LEADER }, "S", "");
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
  test("requests made before a listing starts share it, run for the largest timeout", async () => {
    const runs: number[] = [];
    const list = coalesceUnstarted((timeoutMs) => {
      runs.push(timeoutMs);
      return Promise.resolve(runs.length);
    });
    const joined = [list(1_200), list(3_000), list(2_000)];
    expect(runs).toEqual([]); // nothing starts in the requesting turn
    expect(await Promise.all(joined)).toEqual([1, 1, 1]);
    expect(runs).toEqual([3_000]);
  });

  test("each request still times out on its own deadline, not another's", async () => {
    vi.useFakeTimers();
    try {
      const { promise: table, resolve } = Promise.withResolvers<string>();
      const list = coalesceUnstarted(() => table);
      // A sweep with 10 ms left joins a fresh sweep's read: only the first may time out.
      const nearlySpent = list(10);
      const fresh = list(3_000);
      const timedOut = expect(nearlySpent).rejects.toMatchObject({ code: "ETIMEDOUT" });
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      resolve("table");
      await expect(fresh).resolves.toBe("table");
    } finally {
      vi.useRealTimers();
    }
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
