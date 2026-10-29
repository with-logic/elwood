/**
 * Reads the host process table and finds the process groups a PTY leader's
 * descendants have moved into. Implements PRD §5.3 and §9.4 (C-LIFE-10): Claude and
 * Codex start every hook command with `setsid()`, so a hook runs in its OWN session and
 * process group and a SIGKILL of the leader's group cannot reach it. The parent-pid
 * chain is the only thing tying such a descendant to the leader, and it holds only
 * while every process between them is alive: when any of them exits, the processes
 * below it are reparented to PID 1 and are out of reach. So this walk runs before
 * Elwood kills the leader, and it finds only descendants still linked at that point.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coalesceUnstarted } from "./coalesce.ts";

/** One row of the host process table. */
export type ProcessEntry = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** An exited process its parent has not reaped yet: nothing left to kill. */
  readonly zombie: boolean;
  /** Stopped (state `T`) when its row was read, as a delivered SIGSTOP leaves it. */
  readonly stopped: boolean;
  /** When it started, to the second (`lstart`): with the pid, it names one process. */
  readonly startedAt: string;
  /** Its executable's short name (`ps`'s `ucomm`), at most 16 characters on macOS. */
  readonly name: string;
  /** Codex's shared daemon or its updater, never followed or killed (`shared-daemon.ts`). */
  readonly shared: boolean;
};

// An absolute path, so a caller's PATH can never substitute another `ps`. macOS is
// the only supported platform (PRD §2); `-A -o` is POSIX, so Linux CI parses the same.
export const PS_PATH = "/bin/ps";
const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,ucomm=,pid="] as const;
// Only these: in the C locale `lstart` is always `Www Mmm dd hh:mm:ss yyyy`, so where it
// ends is known, and in UTC a process's start reads the same however the host's zone changes.
const PS_ENV = { LC_ALL: "C", TZ: "UTC" };
// About 80 bytes a row: 16 MiB holds over 200,000 processes, yet bounds a runaway `ps`.
const PS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// The short name may hold spaces or be empty, and `ps` prints it raw, so a newline in it
// starts what reads as another row: each row ends with its pid again (docs/cli-behavior.md).
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+ \S+ +\d+ [\d:]+ \d+)\s(.*)\s(\d+)\s*$/;

/** One process's identity: its pid and start time, which no later process with its pid shares. */
export function processIdentity(row: Pick<ProcessEntry, "pid" | "startedAt">): string {
  return `${row.pid} ${row.startedAt}`;
}

/** A row's fields where no read showed them: a live process not stopped, of no known start. */
export const UNREAD: Omit<ProcessEntry, "pid" | "pgid"> = {
  ppid: 0,
  zombie: false,
  stopped: false,
  startedAt: "",
  name: "",
  shared: false,
};

/** The bounds a `ps` run gets: its timeout, its output cap, and the signal that ends it. */
export type PsRunOptions = {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
  readonly env: Readonly<Record<string, string>>;
};

/** Runs a file to completion and resolves its stdout; `execFile`, promisified. */
export type PsRunner = (
  file: string,
  args: readonly string[],
  options: PsRunOptions,
) => Promise<{ readonly stdout: string }>;

export const runFile: PsRunner = promisify(execFile);

/** The bounds every `ps` run gets: `timeoutMs`, the output cap, SIGKILL, and `PS_ENV`. */
export function psRunOptions(timeoutMs: number): PsRunOptions {
  return { timeout: timeoutMs, maxBuffer: PS_MAX_OUTPUT_BYTES, killSignal: "SIGKILL", env: PS_ENV };
}

/** Lists every process on the host, rejecting when `ps` fails or exceeds `timeoutMs`. */
export async function listProcessTable(
  timeoutMs: number,
  run: PsRunner = runFile,
): Promise<readonly ProcessEntry[]> {
  const { stdout } = await run(PS_PATH, PS_ARGS, psRunOptions(timeoutMs));
  return parseProcessTable(stdout);
}

/** The production listing: concurrent shutdowns share one `ps` per event-loop turn. */
export const listProcessTableShared = coalesceUnstarted(listProcessTable);

/**
 * Parses a `PS_ARGS` read (C locale). Throws on a line that is not one whole row: one cut
 * short, or one whose trailing pid is not its first, as a line a newline in a name
 * started is (`ROW`). Throws, too, on a pid listed twice.
 */
export function parseProcessTable(stdout: string): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [, pid = "", ppid, pgid, state = "", startedAt = "", name = "", trailingPid] =
      ROW.exec(line) ?? [];
    if (pid === "" || pid !== trailingPid) {
      throw new Error("process table read has a line that is not one whole row");
    }
    if (pids.has(Number(pid))) throw new Error(`process table read lists pid ${pid} twice`);
    pids.add(Number(pid));
    entries.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: state.startsWith("Z"),
      stopped: state.startsWith("T"),
      startedAt,
      name: name.trim(),
      shared: false,
    });
  }
  return entries;
}

/**
 * The process groups, other than the leader's own, that hold at least one LIVE
 * descendant of `leaderPid`, each mapped to the rows of its members' parents that sit
 * in OTHER groups (a parent in the same group adds nothing). Descent follows parent
 * pids transitively, so only descendants still linked to the leader when the table was
 * read are found. A returned group holds only descendants: a group lives inside one
 * session, and every member of the leader's session or of a session a descendant
 * created is itself a descendant. Its id is only a snapshot, and is free for reuse
 * once the group is gone, so the parent rows let a caller signal it only once a parent
 * is known to be stopped: a stopped parent cannot reap its exited child, so that child
 * keeps its pid and the group keeps its id. A leader missing from the table is given
 * as a row that is not stopped. The host's group (`hostPid`'s) and the ids `kill(-pgid)`
 * would misroute (`<= 1`) are never returned. Nor is a `shared` process (Codex's daemon
 * or its updater) or anything it started: the walk never descends into one.
 */
export function detachedDescendantGroups(
  table: readonly ProcessEntry[],
  { leaderPid, hostPid }: { readonly leaderPid: number; readonly hostPid: number },
): ReadonlyMap<number, ReadonlySet<ProcessEntry>> {
  const children = childrenByParent(table);
  const leader = table.find((entry) => entry.pid === leaderPid) ?? {
    ...UNREAD,
    pid: leaderPid,
    pgid: leaderPid,
  };
  const excluded = new Set([leaderPid, hostPid, leader.pgid]);
  for (const entry of table) if (entry.pid === hostPid) excluded.add(entry.pgid);
  const groups = new Map<number, Set<ProcessEntry>>();
  const pending = [leader];
  const visited = new Set([leaderPid]);
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (visited.has(child.pid) || child.shared) continue;
      visited.add(child.pid);
      pending.push(child);
      if (child.zombie || child.pgid <= 1 || excluded.has(child.pgid)) continue;
      const parents = groups.get(child.pgid) ?? new Set<ProcessEntry>();
      if (parent.pgid !== child.pgid) parents.add(parent);
      groups.set(child.pgid, parents);
    }
  }
  return groups;
}

/** The table's rows grouped by their parent's pid. */
export function childrenByParent(table: readonly ProcessEntry[]): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  return children;
}
