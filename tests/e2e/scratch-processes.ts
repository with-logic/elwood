/**
 * Stops what a real Codex left running out of a scratch directory, before the directory is
 * removed (PRD §12, C-E2E-03). Codex 0.164 can start a managed app-server daemon for its
 * `CODEX_HOME`: it installs a copy of itself under `<home>/packages/app-server-daemon/` and
 * runs it, with an updater loop, each in its own session, and both move under PID 1 when the
 * TUI exits, outliving it indefinitely while they keep writing into the home
 * (docs/cli-behavior.md, "Codex 0.164 starts an app-server daemon per `CODEX_HOME`"). A
 * process counts as running from the directory when its command line names a path inside it;
 * its descendants count too, being found by parent pid, and stay tracked by pid and command
 * line once signalled, so one reparented to PID 1 is not lost. Each gets SIGTERM, which the
 * daemon answers by stopping its MCP servers and removing its control socket, then SIGKILL
 * once it has outlived the grace period. Synchronous, so a sandbox's `dispose()` and a process
 * `exit` hook can call it.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { type ProcessRow, processRows, type Send } from "../helpers/process-liveness.ts";

/** How long a process from the directory gets after SIGTERM before SIGKILL. */
export const TERM_GRACE_MS = 3_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

/**
 * `dir` as `ps` may show it, tmpdir's spelling and the resolved one, as path prefixes.
 * Throws unless `dir` is an existing directory strictly inside the OS temp directory,
 * where every scratch directory is made: a prefix such as `/`, or the cwd an empty path
 * resolves to, would name every process on the host.
 */
function prefixesOf(dir: string): readonly string[] {
  const resolved = isAbsolute(dir) && statSync(dir).isDirectory() ? realpathSync(dir) : "";
  const offset = relative(realpathSync(tmpdir()), resolved);
  if (resolved === "" || offset === "" || offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error(
      `Refusing to stop processes under ${JSON.stringify(dir)}: not a scratch directory`,
    );
  }
  return [...new Set([`${dir}/`, `${resolved}/`])];
}

/** The live rows naming a path under one of `prefixes`, with their descendants. */
function under(prefixes: readonly string[], table: readonly ProcessRow[]): readonly ProcessRow[] {
  const live = table.filter((row) => !row.stat.startsWith("Z"));
  const inside = (row: ProcessRow) => prefixes.some((prefix) => row.command.includes(prefix));
  const found = new Map(live.filter(inside).map((row) => [row.pid, row]));
  for (let grew = found.size > 0; grew; ) {
    grew = false;
    for (const row of live) {
      if (found.has(row.pid) || !found.has(row.ppid)) continue;
      found.set(row.pid, row);
      grew = true;
    }
  }
  return [...found.values()];
}

/**
 * The live processes whose command line names a path inside `dir`, with their
 * descendants, from `table` or else a fresh read, which follows the check of `dir`.
 */
export function processesUnder(dir: string, table?: readonly ProcessRow[]): readonly ProcessRow[] {
  const prefixes = prefixesOf(dir);
  return under(prefixes, table ?? processRows());
}

/**
 * Whether any process's command line names a path under one of `prefixes`: one `pgrep`, so
 * a directory nothing runs from costs no full process table. A descendant counts only while
 * the process it descends from runs, so a miss here is a miss for `under` too.
 */
function anyNaming(prefixes: readonly string[], timeoutMs: number): boolean {
  const pattern = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const found = spawnSync("/usr/bin/pgrep", ["-f", pattern.join("|")], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (found.status === 0 || found.status === 1) return found.status === 0;
  throw found.error ?? new Error(`pgrep exited ${found.status}: ${found.stderr}`);
}

/** The same process as one signalled earlier: same command, and the same parent or PID 1. */
function stillSignalled(sent: ProcessRow | undefined, row: ProcessRow): boolean {
  return sent?.command === row.command && (row.ppid === sent.ppid || row.ppid === 1);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Stops every process running from `dir` (`processesUnder`) through `send`, which a test
 * can replace to record instead, or throws, in which case the caller must keep the
 * directory: when one is still running 10 s on, or when reading the process table fails
 * or would run past that deadline.
 */
export function stopProcessesUnder(dir: string, send: Send = signal): void {
  const prefixes = prefixesOf(dir);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  if (!anyNaming(prefixes, STOP_TIMEOUT_MS)) return;
  const signalled = new Map<number, ProcessRow & { readonly at: number }>();
  for (;;) {
    const table = processRows(Math.max(1, deadline - Date.now()));
    const running = new Map(under(prefixes, table).map((row) => [row.pid, row]));
    for (const row of table) {
      if (!row.stat.startsWith("Z") && stillSignalled(signalled.get(row.pid), row))
        running.set(row.pid, row);
    }
    if (running.size === 0) return;
    if (Date.now() >= deadline) {
      const rows = [...running.values()].map((row) => `${row.pid} ${row.command}`);
      throw new Error(`Processes still running from ${dir}: ${rows.join("; ")}`);
    }
    for (const row of running.values()) {
      const sent = signalled.get(row.pid);
      if (sent === undefined) {
        send(row.pid, "SIGTERM");
        signalled.set(row.pid, { ...row, at: Date.now() });
      } else if (Date.now() - sent.at >= TERM_GRACE_MS) send(row.pid, "SIGKILL");
    }
    pause(POLL_MS);
  }
}
