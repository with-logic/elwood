/**
 * Reads the host process table and finds the process groups a PTY leader's
 * descendants have moved into. Implements PRD §5.3 and §9.4 (C-LIFE-10): Claude
 * starts every hook command with `setsid()`, so a hook runs in its OWN session and
 * process group and a SIGKILL of the leader's group cannot reach it. The parent-pid
 * link is the only thing tying such a descendant to the leader, and it holds only
 * while the leader is alive — so this walk runs before Elwood kills the leader.
 */

import { execFile } from "node:child_process";

/** One row of the host process table. */
export type ProcessEntry = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** An exited process its parent has not reaped yet: nothing left to kill. */
  readonly zombie: boolean;
};

// An absolute path, so a caller's PATH can never substitute another `ps`. macOS is
// the only supported platform (PRD §2); `-A -o` is POSIX, so Linux CI parses the same.
const PS_PATH = "/bin/ps";
const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat="] as const;
// About 25 bytes per row, so 16 MiB holds over 600,000 processes: far beyond any real
// host, while still bounding what a runaway `ps` can make this process buffer.
const PS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/;

/** Lists every process on the host, rejecting when `ps` fails or exceeds `timeoutMs`. */
export function listProcessTable(timeoutMs: number): Promise<readonly ProcessEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      PS_PATH,
      [...PS_ARGS],
      { timeout: timeoutMs, maxBuffer: PS_MAX_OUTPUT_BYTES, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessTable(stdout));
      },
    );
  });
}

/**
 * Joins every request made before a listing starts into that one listing, so a fleet
 * shutting down together runs one `ps` instead of one per session. A request never
 * joins a listing that has already started: each sweep needs a table read after its
 * own leader was frozen. The listing starts on the next turn of the event loop and
 * uses the smallest timeout any of its requests asked for.
 */
export function coalesceUnstarted<T>(
  run: (timeoutMs: number) => Promise<T>,
): (timeoutMs: number) => Promise<T> {
  type Batch = { timeoutMs: number; readonly result: Promise<T> };
  let open: Batch | undefined;
  return (timeoutMs) => {
    if (open !== undefined) {
      open.timeoutMs = Math.min(open.timeoutMs, timeoutMs);
      return open.result;
    }
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const batch: Batch = { timeoutMs, result: started.then(() => run(batch.timeoutMs)) };
    open = batch;
    setImmediate(() => {
      open = undefined;
      start();
    });
    return batch.result;
  };
}

/** The production listing: concurrent shutdowns share one `ps` per event-loop turn. */
export const listProcessTableShared = coalesceUnstarted(listProcessTable);

/** Parses `ps -o pid=,ppid=,pgid=,stat=` output, skipping any line that is not a row. */
export function parseProcessTable(stdout: string): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: (match[4] as string).startsWith("Z"),
    });
  }
  return entries;
}

/**
 * The process groups, other than the leader's own, that hold at least one LIVE
 * descendant of `leaderPid`. Descent follows parent pids transitively. Every such
 * group is safe to signal: a group lives inside one session, and every member of
 * the leader's session or of a session a descendant created is itself a
 * descendant. The host's own group and the ids `kill(-pgid)` would misroute
 * (`<= 1`) are excluded regardless.
 */
export function detachedDescendantGroups(
  table: readonly ProcessEntry[],
  leaderPid: number,
  hostPid: number = process.pid,
): ReadonlySet<number> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const excluded = new Set([leaderPid, hostPid]);
  for (const entry of table) {
    if (entry.pid === leaderPid || entry.pid === hostPid) excluded.add(entry.pgid);
  }
  const groups = new Set<number>();
  const pending = [leaderPid];
  const visited = new Set<number>(pending);
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      pending.push(child.pid);
      if (!child.zombie && child.pgid > 1 && !excluded.has(child.pgid)) groups.add(child.pgid);
    }
  }
  return groups;
}
