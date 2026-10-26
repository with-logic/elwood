/**
 * The detached walk's one exception (PRD §5.3 and §9.4, C-LIFE-10): Codex's shared
 * app-server daemon, which a Codex TUI starts as a setsid child of its own for its
 * `CODEX_HOME`, is marked in a table read when it is under the walk's roots, and never
 * followed, nor is anything it started. Scripted tables and `ps` reads only.
 */

import { describe, expect, test } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import {
  detachedDescendantGroups,
  type PsRunner,
  parseProcessTable,
} from "../../src/runtime/shutdown/process-table.ts";
import { listMarkingSharedDaemons } from "../../src/runtime/shutdown/shared-daemon.ts";
import {
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

/** Where Codex installs its app-server daemon's copy of the CLI, for a home under `/tmp`. */
const DAEMON = "/tmp/home/.codex/packages/app-server-daemon/releases/0.164.0/bin/codex";
const STANDALONE = "/tmp/home/.codex/packages/standalone/releases/0.164.0/bin/codex";

// Under the session's TUI (5000): read, the `codex` group leaders it started, the daemon
// (5010), its updater (5012), and another (5014); not read, one exited (5015), a non-`codex`
// (5011), one in the TUI's group (5016), and one under a hook (5017). Under no root: a
// daemon whose TUI exited (6000), and the daemon (7010) of the user's own TUI (7000).
const table = parseProcessTable(
  [
    " 5000  4000  5000 Ss+  codex",
    " 5002  5000  5002 Ss   sh",
    " 5010  5000  5010 Ss   codex",
    " 5011  5010  5011 S    codex-code-mode-",
    " 5012  5000  5012 Ss   codex",
    " 5014  5000  5014 Ss   codex",
    " 5015  5000  5015 Z    codex",
    " 5016  5000  5000 S    codex",
    " 5017  5002  5017 Ss   codex",
    " 6000     1  6000 Ss   codex",
    " 7000  4000  7000 Ss+  codex",
    " 7010  7000  7010 Ss   codex",
  ].join("\n"),
);
const list = () => Promise.resolve(table);

/** A runner serving each `-p` read its pid's path, or `failure`, logging every read. */
function runner(paths: Readonly<Record<number, string>>, failure?: unknown) {
  const runs: { args: readonly string[]; timeout: number }[] = [];
  const run: PsRunner = (_file, args, options) => {
    runs.push({ args, timeout: options.timeout });
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({ stdout: `${paths[Number(args.at(-1))]}\n` });
  };
  return { run, runs };
}

const daemons = (rows: readonly { pid: number; sharedDaemon: boolean }[]) =>
  rows.filter((row) => row.sharedDaemon).map((row) => row.pid);
const readPids = (runs: readonly { args: readonly string[] }[]) =>
  runs.map(({ args }) => Number(args.at(-1))).sort();

describe("C-LIFE-10 Codex's shared app-server daemon in a table read", () => {
  test("reads the path of each process under the roots that could be a daemon, one at a time, and marks the daemons", async () => {
    const paths = { 5010: DAEMON, 5012: DAEMON, 5014: STANDALONE, 6000: DAEMON, 7010: DAEMON };
    const { run, runs } = runner(paths);
    expect(daemons(await listMarkingSharedDaemons(3_000, [5000], list, run))).toEqual([5010, 5012]);
    // Given several pids, `ps` reads every process on the host; given one, only that one.
    for (const { args } of runs) expect(args.slice(0, 3)).toEqual(["-o", "comm=", "-p"]);
    expect(readPids(runs)).toEqual([5010, 5012, 5014]);
    for (const entry of runs) expect(entry.timeout).toBeLessThanOrEqual(3_000);
  });

  test("each root is read itself, once even under another, so a daemon under PID 1 is found", async () => {
    const { run, runs } = runner({ 5010: DAEMON, 5012: DAEMON, 5014: STANDALONE, 6000: DAEMON });
    const rows = await listMarkingSharedDaemons(3_000, [5000, 5010, 6000], list, run);
    expect(daemons(rows)).toEqual([5010, 5012, 6000]);
    expect(readPids(runs)).toEqual([5010, 5012, 5014, 6000]);
  });

  test("ends on a read that shows two processes each other's parent", async () => {
    // A read taken while pids are reused can link two processes both ways.
    const looped = parseProcessTable(" 8000  8001  8000 Ss   codex\n 8001  8000  8001 Ss   codex");
    const { run, runs } = runner({ 8000: STANDALONE, 8001: DAEMON });
    const rows = await listMarkingSharedDaemons(3_000, [8000], () => Promise.resolve(looped), run);
    expect(daemons(rows)).toEqual([8001]);
    expect(readPids(runs)).toEqual([8000, 8001]);
  });

  test("no roots, or none with a process that could be a daemon under it, takes no path read", async () => {
    const { run, runs } = runner({});
    expect(daemons(await listMarkingSharedDaemons(3_000, undefined, list, run))).toEqual([]);
    expect(daemons(await listMarkingSharedDaemons(3_000, [5002, 9999], list, run))).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("one gone by its path read is no daemon; any other failed read fails the listing", async () => {
    const gone = Object.assign(new Error("ps exited 1"), { code: 1, stdout: "" });
    expect(
      daemons(await listMarkingSharedDaemons(3_000, [5000], list, runner({}, gone).run)),
    ).toEqual([]);
    for (const failure of [
      Object.assign(new Error("ps killed"), { code: null, killed: true, stdout: "" }),
      Object.assign(new Error("ps exited 1 with output"), { code: 1, stdout: DAEMON }),
      "not an error",
    ]) {
      const { run } = runner({}, failure);
      await expect(listMarkingSharedDaemons(3_000, [5000], list, run)).rejects.toBe(failure);
    }
  });

  test("the sweep marks daemons under its leader in every read it takes", async () => {
    const { ops } = scripted([[leaderRow, hook(5002)]]);
    const roots: unknown[] = [];
    const listProcesses = (timeoutMs: number, given?: readonly number[]) => {
      roots.push(given);
      return ops.listProcesses(timeoutMs);
    };
    const sweep = sweepDetachedGroups(LEADER, { ...ops, listProcesses }, leaderNeverExits, 3_000);
    expect(await sweep).toBeUndefined();
    expect(roots).toEqual(roots.map(() => [LEADER]));
    expect(roots.length).toBeGreaterThan(0);
  });

  test("the walk never follows a daemon, nor anything it started", () => {
    // The daemon and its updater loop are setsid children of the TUI that started them
    // until it exits; the daemon's own children run commands for every Codex on the home.
    const rows = [
      leaderRow,
      hook(5002),
      hook(5010, { name: "codex", sharedDaemon: true }),
      hook(5011, { ppid: 5010, name: "codex-code-mode-", sharedDaemon: true }),
      hook(5012, { ppid: 5010, pgid: 5010, name: "node" }),
      hook(5013, { ppid: 5012 }),
      hook(5014, { ppid: 5002, name: "codex", sharedDaemon: true }), // one a hook started
      hook(5015, { ppid: 5014 }),
    ];
    expect(detachedDescendantGroups(rows, { leaderPid: LEADER, hostPid: process.pid })).toEqual(
      new Map([[5002, new Set([leaderRow])]]),
    );
  });
});
