/**
 * The process-table read and walk against real processes (PRD §5.3 and §9.4,
 * C-LIFE-10): the host table really lists a setsid grandchild under its parent, and the
 * production `ps` options really bound a run's time and output.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import {
  detachedDescendantGroups,
  listProcessTable,
  listProcessTableShared,
  runFile,
} from "../../src/runtime/shutdown/process-table.ts";

// A detached (setsid) leader that starts one detached child and prints the child's pid.
const LEADER_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
process.stdout.write(child.pid + "\\n");
setInterval(() => {}, 1000);
`;

function killGroup(pgid: number | undefined): void {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("C-LIFE-10 real process table", () => {
  test("lists the real host table, including this process under its parent", async () => {
    const table = await listProcessTable(10_000);
    expect(table.find((row) => row.pid === process.pid)).toMatchObject({ ppid: process.ppid });
  });

  test("the production listing reads the real host table", async () => {
    const table = await listProcessTableShared(10_000);
    expect(table.some((row) => row.pid === process.pid)).toBe(true);
  });

  test("finds a real setsid grandchild's group, linked to its leader's group", async () => {
    const leader = spawn(process.execPath, ["-e", LEADER_SCRIPT], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let childPid: number | undefined;
    try {
      const [chunk] = (await once(leader.stdout, "data")) as [Buffer];
      childPid = Number(chunk.toString().trim());
      const leaderPid = leader.pid as number;
      const table = await listProcessTable(10_000);
      expect(table.find((row) => row.pid === leaderPid)).toMatchObject({ pgid: leaderPid });
      expect(table.find((row) => row.pid === childPid)).toMatchObject({
        ppid: leaderPid,
        pgid: childPid,
      });
      expect(detachedDescendantGroups(table, { leaderPid, hostPid: process.pid })).toEqual(
        new Map([[childPid, new Set([leaderPid])]]),
      );
    } finally {
      killGroup(childPid);
      killGroup(leader.pid);
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
