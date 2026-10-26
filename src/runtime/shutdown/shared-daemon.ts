/**
 * Finds the processes of Codex's managed app-server daemon install in a process-table
 * read: the one thing under a session the detached walk never follows or kills (PRD §5.3
 * and §9.4, C-LIFE-10). Codex 0.158 and later can start, for its `CODEX_HOME`, an
 * app-server daemon and its updater loop from the copy of the CLI it installs under
 * `$CODEX_HOME/packages/app-server-daemon/`, each in a session of its own and a child of
 * the TUI that started it until that TUI exits: the shape of a hook. But every Codex on
 * that home talks to the daemon, the user's own included, so neither process nor anything
 * it started is the session's to end (docs/cli-behavior.md). The walk sees only the
 * `shared` mark set here, and the groups `groupIdsToResume` names.
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
  PS_PATH,
  type PsRunner,
  type PsRunOptions,
  psRunOptions,
  runFile,
} from "./process-table.ts";

/** The directory Codex installs its daemon's copy of the CLI in, inside `CODEX_HOME`. */
const DAEMON_INSTALL_DIR = "/packages/app-server-daemon/";
/** The short name of the Codex binary, the TUI's and the daemon's alike. */
const CODEX = "codex";
/** The shortest path-read timeout: Node's `execFile` takes a timeout of 0 as none at all. */
const MIN_PATH_READ_TIMEOUT_MS = 1;

/**
 * Where a walk's reads mark the daemon install: among `roots` and their descendants. The
 * walk passes the set it adds each group it stops to, so a process it stopped is read
 * itself even after its parent's exit leaves it under PID 1. `known` holds each process a
 * read found to be one, by pid, parent, and group, so no later read of the walk probes it
 * again. Only those are remembered, so a stale entry can only spare a process, never
 * expose one, and a process that `exec`s the daemon is found: until a read finds it, a
 * candidate is read again on every read.
 */
export type DaemonScope = { readonly roots: ReadonlySet<number>; readonly known: Set<string> };

/** A fresh scope for one walk from `roots`, which it reads as they stand at each read. */
export function daemonScope(roots: ReadonlySet<number>): DaemonScope {
  return { roots, known: new Set() };
}

/**
 * The shared table read, with each process of Codex's daemon install in `scope` marked
 * `shared`, all within `timeoutMs`. Without a scope, nothing is marked.
 */
export async function listMarkingShared(
  timeoutMs: number,
  scope: DaemonScope = daemonScope(new Set()),
  list: (timeoutMs: number) => Promise<readonly ProcessEntry[]> = listProcessTableShared,
  run: PsRunner = runFile,
): Promise<readonly ProcessEntry[]> {
  const deadline = performance.now() + timeoutMs;
  const table = await list(timeoutMs);
  if (scope.roots.size === 0) return table;
  const remainingMs = Math.ceil(deadline - performance.now());
  const options = psRunOptions(Math.max(MIN_PATH_READ_TIMEOUT_MS, remainingMs));
  return markShared(table, scope, run, options);
}

/** `table`, each install process in `scope` marked; one exited by its read is none. */
async function markShared(
  table: readonly ProcessEntry[],
  { roots, known }: DaemonScope,
  run: PsRunner,
  options: PsRunOptions,
): Promise<readonly ProcessEntry[]> {
  // A root a read missed is taken for a `codex`, as the TUI was: only a path read confirms.
  const names = new Map([...[...roots].map((root) => [root, CODEX] as const), ...nameMap(table)]);
  const candidates = reachable(table, roots).filter((row) => couldBeFromInstall(row, names));
  const key = (row: ProcessEntry) => `${row.pid} ${row.ppid} ${row.pgid}`;
  const unknown = candidates.filter((row) => !known.has(key(row)));
  const probe = async (row: ProcessEntry) => ({ row, path: await pathOf(row.pid, run, options) });
  for (const { row, path } of await Promise.all(unknown.map(probe))) {
    if (path.includes(DAEMON_INSTALL_DIR)) known.add(key(row));
  }
  const found = new Set(candidates.filter((row) => known.has(key(row))).map((row) => row.pid));
  if (found.size === 0) return table;
  return table.map((row) => (found.has(row.pid) ? { ...row, shared: true } : row));
}

/**
 * The groups `table` shows holding a process marked `shared`, or a process that read did
 * not show stopped with the shape of one: it could still `exec` the daemon, as a stopped
 * process cannot. A walk resumes, rather than kills, any of these it stopped.
 */
export function groupIdsToResume(table: readonly ProcessEntry[]): ReadonlySet<number> {
  const names = nameMap(table);
  const rows = table.filter(
    (row) => row.shared || (!row.stopped && couldBeFromInstall(row, names)),
  );
  return new Set(rows.map((row) => row.pgid));
}

/** Each process's short name, by pid, as `couldBeFromInstall` takes them. */
function nameMap(table: readonly ProcessEntry[]): ReadonlyMap<number, string> {
  return new Map(table.map((row) => [row.pid, row.name]));
}

/**
 * Whether `row` has the shape of the daemon or its updater in a table read; only its path
 * can confirm it.
 */
function couldBeFromInstall(row: ProcessEntry, names: ReadonlyMap<number, string>): boolean {
  const live = !row.zombie;
  const runsCodex = row.name === CODEX;
  const leadsOwnGroup = row.pgid === row.pid;
  const parentIsCodexOrInit = row.ppid === 1 || names.get(row.ppid) === CODEX;
  return live && runsCodex && leadsOwnGroup && parentIsCodexOrInit;
}

/**
 * The rows of `roots` and of every process descending from one, by parent pid. A root
 * missing from the read still parents its children, as in `detachedDescendantGroups`.
 */
function reachable(table: readonly ProcessEntry[], roots: ReadonlySet<number>): ProcessEntry[] {
  const children = childrenByParent(table);
  const found = new Map<number, ProcessEntry>();
  const pending = table.filter((row) => roots.has(row.pid) || roots.has(row.ppid));
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
