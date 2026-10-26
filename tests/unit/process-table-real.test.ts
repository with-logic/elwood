/**
 * The process-table read and walk against real processes (PRD §5.3 and §9.4,
 * C-LIFE-10): the host table really lists a setsid grandchild under its parent, reads a
 * SIGSTOPped process as stopped, and the production `ps` options really bound a run's
 * time and output.
 */

import { describe, expect, test } from "vitest";
import {
  detachedDescendantGroups,
  listProcessTable,
  listProcessTableShared,
  runFile,
} from "../../src/runtime/shutdown/process-table.ts";
import { type SetsidPair, startSetsidPair, stopPair } from "../helpers/setsid-pair.ts";
import { readUntil } from "../helpers/table-reads.ts";

describe("C-LIFE-10 real process table", () => {
  test("lists the real host table, including this process under its parent", async () => {
    const table = await listProcessTable(10_000);
    expect(table.find((row) => row.pid === process.pid)).toMatchObject({ ppid: process.ppid });
  });

  test("the production listing reads the real host table", async () => {
    const table = await listProcessTableShared(10_000);
    expect(table.some((row) => row.pid === process.pid)).toBe(true);
  });

  test("finds a real setsid grandchild's group, linked to its leader's row", async () => {
    let pair: SetsidPair | undefined;
    try {
      pair = await startSetsidPair();
      const { childPid } = pair;
      const leaderPid = pair.leader.pid as number;
      const table = await listProcessTable(10_000);
      const leaderRow = table.find((row) => row.pid === leaderPid);
      expect(leaderRow).toMatchObject({ pgid: leaderPid, stopped: false });
      expect(table.find((row) => row.pid === childPid)).toMatchObject({
        ppid: leaderPid,
        pgid: childPid,
      });
      expect(detachedDescendantGroups(table, { leaderPid, hostPid: process.pid })).toEqual(
        new Map([[childPid, new Set([leaderRow])]]),
      );
    } finally {
      await stopPair(pair);
    }
  });

  test("reads a really SIGSTOPped leader as stopped, on its parent row too", async () => {
    let pair: SetsidPair | undefined;
    try {
      pair = await startSetsidPair();
      const leaderPid = pair.leader.pid as number;
      pair.leader.kill("SIGSTOP");
      // kill() returning means the signal was sent; it shows in a read once delivered.
      const table = await readUntil(leaderPid, (row) => row?.stopped === true);
      const leaderRow = table.find((row) => row.pid === leaderPid);
      expect(leaderRow).toMatchObject({ stopped: true, zombie: false });
      const groups = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
      expect([...(groups.get(pair.childPid) ?? [])]).toEqual([leaderRow]);
    } finally {
      await stopPair(pair);
    }
  });

  test("a run past its timeout is SIGKILLed and rejects", async () => {
    const hang = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"];
    const listing = listProcessTable(200, (_file, _args, options) =>
      runFile(process.execPath, hang, options),
    );
    await expect(listing).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
  });

  test("a run that writes past the 16 MiB cap rejects", async () => {
    const flood = ["-e", "process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1))"];
    const listing = listProcessTable(10_000, (_file, _args, options) =>
      runFile(process.execPath, flood, options),
    );
    await expect(listing).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
});
