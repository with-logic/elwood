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
 * At most `PATH_READS_AT_ONCE` run at once, and none starts past the read's deadline: the
 * read then fails, as one that timed out does.
 *
 * Every test here is on what `ps` reports, which a process can set for itself, so one that
 * imitates the daemon is spared as one. That gives a descendant nothing it lacks: one whose
 * parent exits before the walk is out of its reach already (PRD §5.3).
 */

import {
  childrenByParent,
  listProcessTableShared,
  type ProcessEntry,
  PS_PATH,
  type PsRunner,
  psRunOptions,
  runFile,
} from "./process-table.ts";

/** The directory Codex installs its daemon's copy of the CLI in, inside `CODEX_HOME`. */
const DAEMON_INSTALL_DIR = "/packages/app-server-daemon/";
/** The short name of the Codex binary, the TUI's and the daemon's alike. */
const CODEX = "codex";
/**
 * The most path reads, each a `ps` of its own, that one table read runs at once. A real
 * session shows at most two candidates, the daemon and its updater, so both are read in
 * one round, with room to spare; past that, each further `ps` at once costs a loaded host
 * about another table read just as a fleet's shutdown loads it most (docs/cli-behavior.md).
 */
export const PATH_READS_AT_ONCE = 4;

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
export async function listProcessTableMarkingDaemon(
  timeoutMs: number,
  scope: DaemonScope = daemonScope(new Set()),
  list: (timeoutMs: number) => Promise<readonly ProcessEntry[]> = listProcessTableShared,
  run: PsRunner = runFile,
): Promise<readonly ProcessEntry[]> {
  const deadline = performance.now() + timeoutMs;
  const table = await list(timeoutMs);
  if (scope.roots.size === 0) return table;
  return markShared(table, scope, (pid) => pathOf(pid, run, deadline));
}

/** `table`, each install process in `scope` marked; one exited by its read is none. */
async function markShared(
  table: readonly ProcessEntry[],
  { roots, known }: DaemonScope,
  readPath: (pid: number) => Promise<string>,
): Promise<readonly ProcessEntry[]> {
  // A root a read missed is taken for a `codex`, as the TUI was: only a path read confirms.
  const names = new Map([...[...roots].map((root) => [root, CODEX] as const), ...nameMap(table)]);
  const candidates = reachable(table, roots).filter((row) => couldBeFromInstall(row, names));
  const key = (row: ProcessEntry) => `${row.pid} ${row.ppid} ${row.pgid}`;
  const unknown = candidates.filter((row) => !known.has(key(row)));
  const probe = async (row: ProcessEntry) => ({ row, path: await readPath(row.pid) });
  for (let next = 0; next < unknown.length; next += PATH_READS_AT_ONCE) {
    const reads = unknown.slice(next, next + PATH_READS_AT_ONCE).map(probe);
    for (const { row, path } of await Promise.all(reads)) {
      if (path.includes(DAEMON_INSTALL_DIR)) known.add(key(row));
    }
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

/**
 * The `comm` of `pid`, or `""` once it has exited. Past `deadline`, it fails as a table
 * read that timed out does (`ETIMEDOUT`), whether it never started or ran out of time.
 */
function pathOf(pid: number, run: PsRunner, deadline: number): Promise<string> {
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) return Promise.reject(timedOut("before its path reads"));
  return run(PS_PATH, ["-o", "comm=", "-p", String(pid)], psRunOptions(remainingMs)).then(
    (result) => result.stdout.trim(),
    (error: unknown) => {
      if (isTargetPidMissing(error)) return "";
      if (performance.now() >= deadline) throw timedOut("in a path read");
      throw error;
    },
  );
}

function timedOut(where: string): Error {
  return Object.assign(new Error(`process table read timed out ${where}`), {
    code: "ETIMEDOUT",
  });
}

/** `ps -p` found no such process: it exits 1 and prints nothing. */
function isTargetPidMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === 1 && "stdout" in error && error.stdout === "";
}
