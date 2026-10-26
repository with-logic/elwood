/**
 * Finds Codex's managed app-server daemon in a process-table read, the one descendant
 * the detached walk never follows (PRD §5.3 and §9.4, C-LIFE-10). Codex 0.158 and later
 * can start, for its `CODEX_HOME`, an app-server daemon and its updater loop from the
 * copy of the CLI it installs under `$CODEX_HOME/packages/app-server-daemon/`, each in a
 * session of its own and a child of the TUI that started it until that TUI exits: the
 * shape of a hook. But every Codex on that home talks to it, the user's own included,
 * so neither it nor anything it started is the session's to end (docs/cli-behavior.md).
 *
 * Codex starts both by their full paths, which macOS `ps` shows as `comm` (`argv[0]`).
 * Each `ps` the host spawns while a session ends costs about as much as its table read,
 * so `comm` is read only for the processes the caller's walk can reach that could be
 * one, each by a `ps` of its own (given several pids, `ps` reads every process): one of
 * `roots` or a descendant, named `codex` (`ucomm`), leading its own group, and a child of
 * a process named `codex` or of PID 1. A walk with none under its roots spawns no `ps`.
 */

import {
  childrenByParent,
  listProcessTableShared,
  type ProcessEntry,
  type PsRunner,
  type PsRunOptions,
  psRunOptions,
  runFile,
} from "./process-table.ts";

/** The directory Codex installs its daemon's copy of the CLI in, inside `CODEX_HOME`. */
const DAEMON_INSTALL_DIR = "/packages/app-server-daemon/";
/** The short name of the Codex binary, the TUI's and the daemon's alike. */
const CODEX = "codex";
const PS_PATH = "/bin/ps";

/**
 * The shared table read, with each of Codex's daemons among `roots` and their
 * descendants marked `sharedDaemon`, all within `timeoutMs`.
 */
export async function listMarkingSharedDaemons(
  timeoutMs: number,
  roots: readonly number[] = [],
  list: (timeoutMs: number) => Promise<readonly ProcessEntry[]> = listProcessTableShared,
  run: PsRunner = runFile,
): Promise<readonly ProcessEntry[]> {
  const deadline = performance.now() + timeoutMs;
  const table = await list(timeoutMs);
  const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
  return markSharedDaemons(table, roots, run, psRunOptions(remainingMs));
}

/** `table`, each daemon under `roots` marked; one exited by its read (`ps` exits 1) is none. */
async function markSharedDaemons(
  table: readonly ProcessEntry[],
  roots: readonly number[],
  run: PsRunner,
  options: PsRunOptions,
): Promise<readonly ProcessEntry[]> {
  const names = new Map(table.map((row) => [row.pid, row.name]));
  const candidates = reachable(table, roots).filter(
    (row) =>
      !row.zombie &&
      row.name === CODEX &&
      row.pgid === row.pid &&
      (row.ppid === 1 || names.get(row.ppid) === CODEX),
  );
  if (candidates.length === 0) return table;
  const isDaemon = async ({ pid }: ProcessEntry) =>
    (await pathOf(pid, run, options)).includes(DAEMON_INSTALL_DIR) ? [pid] : [];
  const daemons = new Set((await Promise.all(candidates.map(isDaemon))).flat());
  return table.map((row) => (daemons.has(row.pid) ? { ...row, sharedDaemon: true } : row));
}

/** The rows of `roots` and of every process descending from one, by parent pid. */
function reachable(table: readonly ProcessEntry[], roots: readonly number[]): ProcessEntry[] {
  const children = childrenByParent(table);
  const found = new Map<number, ProcessEntry>();
  const pending = table.filter((row) => roots.includes(row.pid));
  for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
    if (found.has(row.pid)) continue;
    found.set(row.pid, row);
    pending.push(...(children.get(row.pid) ?? []));
  }
  return [...found.values()];
}

/** The `comm` of `pid`, or `""` once it has exited. */
function pathOf(pid: number, run: PsRunner, options: PsRunOptions): Promise<string> {
  return run(PS_PATH, ["-o", "comm=", "-p", String(pid)], options).then(
    (result) => result.stdout.trim(),
    (error: unknown) => {
      if (exited(error)) return "";
      throw error;
    },
  );
}

/** `ps -p` found no such process: it exits 1 and prints nothing. */
function exited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === 1 && "stdout" in error && error.stdout === "";
}
