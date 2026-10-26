/**
 * The detached walk's one exception (PRD §5.3 and §9.4, C-LIFE-10): Codex's shared
 * app-server daemon, which a Codex TUI starts as a setsid child of its own for its
 * `CODEX_HOME`, is marked in a table read when it is in the walk's scope. Scripted tables
 * and `ps` reads only.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProcessEntry, PsRunner } from "../../src/runtime/shutdown/process-table.ts";
import {
  type DaemonScope,
  daemonScope,
  listProcessTableMarkingDaemon,
} from "../../src/runtime/shutdown/shared-daemon.ts";
import { hook, LEADER, leaderRow } from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Where Codex installs its app-server daemon's copy of the CLI, for a home under `/tmp`. */
const DAEMON = "/tmp/home/.codex/packages/app-server-daemon/releases/0.164.0/bin/codex";
const STANDALONE = "/tmp/home/.codex/packages/standalone/releases/0.164.0/bin/codex";
const GONE = Object.assign(new Error("ps exited 1"), { code: 1, stdout: "" });

const codex = (pid: number, options: Parameters<typeof hook>[1] = {}) =>
  hook(pid, { name: "codex", ...options });
// Under the session's TUI (5000): read, the `codex` group leaders it started, the daemon
// (5010), its updater (5012), and another (5014); not read, one exited (5015), a non-`codex`
// (5011), one in the TUI's group (5016), and one under a hook (5017). Under no root: a
// daemon whose TUI exited (6000), and the daemon (7010) of the user's own TUI (7000).
const table: readonly ProcessEntry[] = [
  { ...leaderRow, ppid: 4000 },
  hook(5002),
  codex(5010),
  hook(5011, { ppid: 5010, name: "codex-code-mode-" }),
  codex(5012),
  codex(5014),
  codex(5015, { zombie: true }),
  codex(5016, { pgid: LEADER }),
  codex(5017, { ppid: 5002 }),
  codex(6000, { ppid: 1 }),
  codex(7000, { ppid: 4000 }),
  codex(7010, { ppid: 7000 }),
];
const list = () => Promise.resolve(table);

/**
 * A runner serving each `-p` read its pid's path or rejection, logging every read; given
 * `every`, each read rejects with `every.rejectWith`. A pid with neither fails the test.
 */
function runner(
  paths: Readonly<Record<number, string | Error>>,
  every?: { readonly rejectWith: unknown },
) {
  const runs: { pid: number; timeout: number; args: readonly string[] }[] = [];
  const run: PsRunner = (_file, args, options) => {
    const pid = Number(args.at(-1));
    runs.push({ pid, timeout: options.timeout, args });
    if (every !== undefined) return Promise.reject(every.rejectWith);
    const path = paths[pid];
    if (path === undefined) throw new Error(`no path scripted for ${pid}`);
    if (path instanceof Error) return Promise.reject(path);
    return Promise.resolve({ stdout: `${path}\n` });
  };
  return { run, runs, pids: () => runs.map((entry) => entry.pid).sort() };
}

const daemons = (rows: readonly ProcessEntry[]) =>
  rows.filter((row) => row.shared).map((row) => row.pid);
const mark = (scope: DaemonScope, run: PsRunner, rows = list) =>
  listProcessTableMarkingDaemon(3_000, scope, rows, run).then(daemons);
const scopeOf = (...roots: number[]) => daemonScope(new Set(roots));

describe("C-LIFE-10 Codex's shared app-server daemon in a table read", () => {
  test("reads the path of each process in scope that could be a daemon, once if it is one", async () => {
    const { run, runs, pids } = runner({ 5010: DAEMON, 5012: DAEMON, 5014: STANDALONE });
    const scope = scopeOf(LEADER);
    expect(await mark(scope, run)).toEqual([5010, 5012]);
    // One pid each: given several, `ps` reads every process on the host.
    expect(runs.map((entry) => entry.args)).toEqual(
      runs.map((entry) => ["-o", "comm=", "-p", String(entry.pid)]),
    );
    expect(await mark(scope, run)).toEqual([5010, 5012]);
    expect(pids()).toEqual([5010, 5012, 5014, 5014]);
    await mark(scopeOf(LEADER), run);
    expect(pids()).toEqual([5010, 5010, 5012, 5012, 5014, 5014, 5014]);
  });

  test("reads up to four paths at once, each within what the table read left of the deadline", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const slowList = () => {
      clock += 1_000;
      return list();
    };
    const pending = Promise.withResolvers<{ stdout: string }>();
    const { run, runs } = runner({ 5010: DAEMON, 5012: DAEMON, 5014: DAEMON });
    const held: PsRunner = (...args) => {
      void run(...args);
      return pending.promise;
    };
    const marking = mark(scopeOf(LEADER), held, slowList);
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(runs.map((entry) => entry.timeout)).toEqual([2_000, 2_000, 2_000]);
    pending.resolve({ stdout: `${DAEMON}\n` });
    expect(await marking).toEqual([5010, 5012, 5014]);
  });

  test("each root is read itself, once even under another, so a daemon under PID 1 is found", async () => {
    const { run, pids } = runner({ 5010: DAEMON, 5012: DAEMON, 5014: STANDALONE, 6000: DAEMON });
    expect(await mark(scopeOf(LEADER, 5010, 6000), run)).toEqual([5010, 5012, 6000]);
    expect(pids()).toEqual([5010, 5012, 5014, 6000]);
  });

  test("a root missing from the read still has its children read and marked", async () => {
    // `ps` can read a leader's children in the same pass the leader's own row left.
    const { run } = runner({ 5010: DAEMON, 5012: DAEMON, 5014: STANDALONE });
    const unread = () => list().then((rows) => rows.filter((row) => row.pid !== LEADER));
    expect(await mark(scopeOf(LEADER), run, unread)).toEqual([5010, 5012]);
  });

  test("ends on a read that shows two processes each other's parent", async () => {
    // A read taken while pids are reused can link two processes both ways.
    const looped = () =>
      Promise.resolve([codex(8000, { ppid: 8001 }), codex(8001, { ppid: 8000 })]);
    const { run, pids } = runner({ 8000: STANDALONE, 8001: DAEMON });
    expect(await mark(scopeOf(8000), run, looped)).toEqual([8001]);
    expect(pids()).toEqual([8000, 8001]);
  });

  test("by default reads the host's own table, and with no scope marks nothing", async () => {
    const rows = await listProcessTableMarkingDaemon(10_000);
    expect(rows.find((row) => row.pid === process.pid)).toMatchObject({ shared: false });
    expect(daemons(rows)).toEqual([]);
  });

  test("no scope, or none with a process that could be a daemon in it, takes no path read", async () => {
    const { run, runs } = runner({});
    expect(daemons(await listProcessTableMarkingDaemon(3_000, undefined, list, run))).toEqual([]);
    expect(await mark(scopeOf(5002, 9999), run)).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("one gone by its path read is no daemon, while another is still marked", async () => {
    const { run } = runner({ 5010: DAEMON, 5012: GONE, 5014: STANDALONE });
    expect(await mark(scopeOf(LEADER), run)).toEqual([5010]);
  });

  test("any other failed path read fails the listing", async () => {
    for (const failure of [
      Object.assign(new Error("ps killed"), { code: null, killed: true, stdout: "" }),
      Object.assign(new Error("ps exited 1 with output"), { code: 1, stdout: DAEMON }),
      "not an error",
    ]) {
      const { run } = runner({}, { rejectWith: failure });
      await expect(mark(scopeOf(LEADER), run)).rejects.toBe(failure);
    }
  });
});
