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

/** One row of the host process table. */
export type ProcessEntry = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** An exited process its parent has not reaped yet: nothing left to kill. */
  readonly zombie: boolean;
  /** Stopped (state `T`) when its row was read, as a delivered SIGSTOP leaves it. */
  readonly stopped: boolean;
  /** Its executable's short name (`ps`'s `ucomm`), at most 16 characters on macOS. */
  readonly name: string;
};

// An absolute path, so a caller's PATH can never substitute another `ps`. macOS is
// the only supported platform (PRD §2); `-A -o` is POSIX, so Linux CI parses the same.
const PS_PATH = "/bin/ps";
const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,ucomm=,pid="] as const;
// About 50 bytes per row, so 16 MiB holds over 300,000 processes: far beyond any real
// host, while still bounding what a runaway `ps` can make this process buffer.
const PS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// The short name may hold spaces or be empty, and `ps` prints it raw, so a newline in it
// starts what reads as another row: each row ends with its pid again (docs/cli-behavior.md).
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s(.*)\s(\d+)\s*$/;

/** The bounds a `ps` run gets: its timeout, its output cap, and the signal that ends it. */
export type PsRunOptions = {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
};

/** Runs a file to completion and resolves its stdout; `execFile`, promisified. */
export type PsRunner = (
  file: string,
  args: readonly string[],
  options: PsRunOptions,
) => Promise<{ readonly stdout: string }>;

export const runFile: PsRunner = promisify(execFile);

/** Lists every process on the host, rejecting when `ps` fails or exceeds `timeoutMs`. */
export async function listProcessTable(
  timeoutMs: number,
  run: PsRunner = runFile,
): Promise<readonly ProcessEntry[]> {
  const options: PsRunOptions = {
    timeout: timeoutMs,
    maxBuffer: PS_MAX_OUTPUT_BYTES,
    killSignal: "SIGKILL",
  };
  const { stdout } = await run(PS_PATH, PS_ARGS, options);
  return parseProcessTable(stdout);
}

/**
 * Joins every request made before a listing starts into that one listing, so a fleet
 * shutting down together runs one `ps` instead of one per session. A request never
 * joins a listing that has already started: each sweep needs a table read after its
 * own leader was frozen. The listing starts on the next turn of the event loop and may
 * run for the largest timeout any of its requests asked for, while each request still
 * rejects with `ETIMEDOUT` at its own timeout: one session's nearly spent deadline never
 * cuts short another's read.
 */
export function coalesceUnstarted<T>(
  run: (timeoutMs: number) => Promise<T>,
): (timeoutMs: number) => Promise<T> {
  type Batch = { timeoutMs: number; readonly result: Promise<T> };
  let open: Batch | undefined;
  const startBatch = (timeoutMs: number): Batch => {
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const batch: Batch = { timeoutMs, result: started.then(() => run(batch.timeoutMs)) };
    setImmediate(() => {
      open = undefined;
      start();
    });
    return batch;
  };
  return (timeoutMs) => {
    open ??= startBatch(timeoutMs);
    open.timeoutMs = Math.max(open.timeoutMs, timeoutMs);
    return withinOwnTimeout(open.result, timeoutMs);
  };
}

/** `result`, or an `ETIMEDOUT` rejection once `timeoutMs` passes first. */
function withinOwnTimeout<T>(result: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("process table read timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  return Promise.race([result, timedOut]).finally(() => clearTimeout(timer));
}

/** The production listing: concurrent shutdowns share one `ps` per event-loop turn. */
export const listProcessTableShared = coalesceUnstarted(listProcessTable);

/** Parses `ps -o pid=,ppid=,pgid=,stat=,ucomm=,pid=`; throws on a partial row or a pid twice. */
export function parseProcessTable(stdout: string): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = ROW.exec(line);
    if (!match || match[1] !== match[6] || pids.has(Number(match[1]))) {
      throw new Error("process table read has a line that is not one whole row");
    }
    pids.add(Number(match[1]));
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: (match[4] as string).startsWith("Z"),
      stopped: (match[4] as string).startsWith("T"),
      name: (match[5] as string).trim(),
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
 * as a row that is not stopped. The host's group (`hostPid`'s) and the ids
 * `kill(-pgid)` would misroute (`<= 1`) are never returned.
 */
export function detachedDescendantGroups(
  table: readonly ProcessEntry[],
  { leaderPid, hostPid }: { readonly leaderPid: number; readonly hostPid: number },
): ReadonlyMap<number, ReadonlySet<ProcessEntry>> {
  const children = childrenByParent(table);
  const leader = table.find((entry) => entry.pid === leaderPid) ?? {
    pid: leaderPid,
    ppid: 0,
    pgid: leaderPid,
    zombie: false,
    stopped: false,
    name: "",
  };
  const excluded = new Set([leaderPid, hostPid, leader.pgid]);
  for (const entry of table) if (entry.pid === hostPid) excluded.add(entry.pgid);
  const groups = new Map<number, Set<ProcessEntry>>();
  const pending = [leader];
  const visited = new Set([leaderPid]);
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (visited.has(child.pid)) continue;
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

function childrenByParent(table: readonly ProcessEntry[]): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  return children;
}
