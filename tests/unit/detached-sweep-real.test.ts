/**
 * The detached sweep against real processes (PRD §5.3 and §9.4, C-LIFE-10): with real
 * SIGSTOP, SIGKILL, and `/bin/ps`, a live setsid leader's setsid child is stopped and
 * killed, the leader is left stopped for its own group reap, and a detached process
 * that does not descend from the leader keeps running.
 */

import { describe, expect, test } from "vitest";
import {
  type SweepOps,
  sweepDetachedGroups,
} from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { listProcessTable, type ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import {
  hasExited,
  type SetsidPair,
  startBystander,
  startSetsidPair,
  stopPair,
} from "../helpers/setsid-pair.ts";

const realOps: SweepOps = {
  stopGroup: (pgid) => process.kill(-pgid, "SIGSTOP"),
  killGroup: (pgid) => process.kill(-pgid, "SIGKILL"),
  listProcesses: listProcessTable,
};

/** Reads the table until `pid`'s row satisfies `check`, for at most five seconds in all. */
async function rowWhen(pid: number, check: (row: ProcessEntry | undefined) => boolean) {
  const deadline = performance.now() + 5_000;
  let row: ProcessEntry | undefined;
  for (let remainingMs = 5_000; remainingMs > 0; ) {
    row = (await listProcessTable(remainingMs)).find((entry) => entry.pid === pid);
    if (check(row)) return row;
    remainingMs = Math.ceil(deadline - performance.now());
  }
  return row;
}

describe("C-LIFE-10 detached sweep on real processes", () => {
  test("kills a real setsid child's group and leaves a bystander running", async () => {
    let pair: SetsidPair | undefined;
    const bystander = startBystander();
    try {
      pair = await startSetsidPair();
      const { leader, childPid } = pair;
      // A generous budget: under load one `ps` can take most of a second.
      const failure = await sweepDetachedGroups(
        leader.pid as number,
        realOps,
        () => hasExited(leader),
        20_000,
      );
      expect(failure).toBeUndefined();
      // The leader is still stopped, so it cannot reap its killed child: a zombie remains.
      expect(await rowWhen(childPid, (row) => row?.zombie === true)).toMatchObject({
        zombie: true,
      });
      const table = await listProcessTable(10_000);
      expect(table.find((row) => row.pid === leader.pid)).toMatchObject({ stopped: true });
      expect(table.find((row) => row.pid === bystander.pid)).toMatchObject({
        zombie: false,
        stopped: false,
      });
    } finally {
      bystander.kill("SIGKILL");
      await stopPair(pair);
    }
  }, 60_000);
});
