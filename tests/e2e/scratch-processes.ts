/**
 * Stops what a real Codex left running out of a scratch directory, before the directory is
 * removed (PRD §12, C-E2E-03). Codex 0.164 can start a managed app-server daemon for its
 * `CODEX_HOME`: it installs a copy of itself under `<home>/packages/app-server-daemon/` and
 * runs it, with an updater loop, each in its own session, and both move under PID 1 when the
 * TUI exits, outliving it indefinitely while they keep writing into the home
 * (docs/cli-behavior.md, "Codex 0.164 starts an app-server daemon per `CODEX_HOME`"). A
 * process counts as running from the directory when its command line names a
 * path inside it; its descendants count too, being found by parent pid, and stay tracked by pid
 * and command line once signalled, so one reparented to PID 1 is not lost. Each gets SIGTERM,
 * which the daemon answers by stopping its MCP servers and removing its control socket, then
 * SIGKILL once it has outlived the grace period. Synchronous, so a sandbox's `dispose()` and a
 * process `exit` hook can call it.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** One process, as `ps -o pid=,ppid=,command=` lists it. */
export type ScratchProcess = {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
};

const ROW = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const TERM_GRACE_MS = 3_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

function processTable(): readonly ScratchProcess[] {
  const listing = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing.split("\n").flatMap((line) => {
    const match = ROW.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: `${match[3]}` }] : [];
  });
}

/** The processes in `table` whose command line names a path inside `dir`, with their descendants. */
export function processesUnder(
  dir: string,
  table: readonly ScratchProcess[] = processTable(),
): readonly ScratchProcess[] {
  // `ps` shows whichever spelling the process was started with: tmpdir's or the resolved one.
  const prefixes = [`${dir}/`, `${realpathSync(dir)}/`];
  const inside = (row: ScratchProcess) => prefixes.some((prefix) => row.command.includes(prefix));
  const found = new Map(table.filter(inside).map((row) => [row.pid, row]));
  for (let grew = found.size > 0; grew; ) {
    grew = false;
    for (const row of table) {
      if (found.has(row.pid) || !found.has(row.ppid)) continue;
      found.set(row.pid, row);
      grew = true;
    }
  }
  return [...found.values()];
}

/** The same process as one signalled earlier: same command, and the same parent or PID 1. */
function stillSignalled(sent: ScratchProcess | undefined, row: ScratchProcess): boolean {
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
 * Stops every process running from `dir` (`processesUnder`), or throws naming each one still
 * running after 10 s, in which case the caller must keep the directory.
 */
export function stopProcessesUnder(dir: string): void {
  const signalled = new Map<number, ScratchProcess & { readonly at: number }>();
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    const table = processTable();
    const running = new Map(processesUnder(dir, table).map((row) => [row.pid, row]));
    for (const row of table)
      if (stillSignalled(signalled.get(row.pid), row)) running.set(row.pid, row);
    if (running.size === 0) return;
    if (Date.now() >= deadline) {
      const rows = [...running.values()].map((row) => `${row.pid} ${row.command}`);
      throw new Error(`Processes still running from ${dir}: ${rows.join("; ")}`);
    }
    for (const row of running.values()) {
      const sent = signalled.get(row.pid);
      if (sent === undefined) {
        signal(row.pid, "SIGTERM");
        signalled.set(row.pid, { ...row, at: Date.now() });
      } else if (Date.now() - sent.at >= TERM_GRACE_MS) signal(row.pid, "SIGKILL");
    }
    pause(POLL_MS);
  }
}
