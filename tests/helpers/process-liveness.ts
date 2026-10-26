/**
 * Pid probes and last-resort cleanup for real-process tests (PRD §5.3 and §9.4,
 * C-LIFE-10). A pid is just a number the OS can reuse once its process is reaped, so a
 * test signals what it owns through a handle it holds wherever it can, and treats a
 * bare pid as a probe target only. `killIfCommandHas` and `killGroupsWhoseCommandHas`
 * are the fallbacks for processes no handle reaches any more: they narrow, but cannot
 * close, the window between reading a command line and signaling it.
 */

import { execFileSync } from "node:child_process";

/** How often `pollGone` probes. */
export const POLL_INTERVAL_MS = 20;

/** Whether `pid` exists: running, stopped, or an unreaped zombie. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` no longer exists, for up to `timeoutMs` of wall time; true once gone. */
export async function pollGone({
  pid,
  timeoutMs,
}: {
  readonly pid: number;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (pidExists(pid)) {
    if (performance.now() >= deadline) return false;
    await delay(POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * SIGKILLs `pid` only if its command line contains `marker` when read. The pid can
 * still change hands between that read and the signal, so callers use this only for a
 * process that no handle they hold can reach. Throws when `ps` itself fails.
 */
export function killIfCommandHas(pid: number, marker: string, send: Send = sendSignal): void {
  assertMarkerMeetsMinimumLength(marker);
  if (!commandOf(pid)?.includes(marker)) return;
  try {
    send(pid, "SIGKILL");
  } catch {
    // It exited between the read and the kill.
  }
}

/** One process, as `ps -A -o pid=,ppid=,pgid=,stat=,command=` lists it. */
export type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps`'s state column; an unreaped zombie's starts with `Z`. */
  readonly stat: string;
  readonly command: string;
};

/**
 * Every process on the host with its command line. Throws when `ps` fails, or runs past
 * `timeoutMs` (unbounded when omitted), in which case it is killed.
 */
export function processRows(timeoutMs?: number): readonly ProcessRow[] {
  const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,command="], {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
    killSignal: "SIGKILL",
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  }).toString();
  return table.split("\n").flatMap((line) => {
    const [, pid, ppid, pgid, stat, command] =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
    if (command === undefined) return [];
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat: `${stat}`, command }];
  });
}

/**
 * SIGKILLs every live process whose command line contains `marker` when read, its whole
 * group when it heads one (as a `setsid` process does), and returns how many it
 * signaled. `marker` must name only processes the caller started, such as the fresh
 * temp directory they run from. Throws when `ps` itself fails.
 */
export function killGroupsWhoseCommandHas(marker: string, send: Send = sendSignal): number {
  assertMarkerMeetsMinimumLength(marker);
  let signaled = 0;
  for (const { pid, pgid, stat, command } of processRows()) {
    if (stat.startsWith("Z") || !command.includes(marker)) continue;
    try {
      send(pid === pgid ? -pgid : pid, "SIGKILL");
    } catch {
      // It exited between the read and the kill.
    }
    signaled += 1;
  }
  return signaled;
}

/** Sends `signal` to `pid` (a negative pid names a group); a test can record instead. */
export type Send = (pid: number, signal: NodeJS.Signals) => void;

const sendSignal: Send = (pid, signal) => void process.kill(pid, signal);

/** The fewest non-blank characters a kill marker may have. */
const MIN_MARKER_LENGTH = 12;

/**
 * Throws for a marker shorter than `MIN_MARKER_LENGTH` non-blank characters: an empty one
 * is in every command line, so a variable that came out empty would kill every process
 * on the host. Length is all it checks. The caller must still pass a marker that names
 * only its own processes, such as a fresh temp directory or a random-suffixed command.
 */
function assertMarkerMeetsMinimumLength(marker: string): void {
  if (marker.trim().length < MIN_MARKER_LENGTH) {
    throw new Error(
      `Refusing to kill by the marker ${JSON.stringify(marker)}: shorter than ${MIN_MARKER_LENGTH} non-blank characters`,
    );
  }
}

/** `pid`'s command line, or `undefined` when no such process exists. */
function commandOf(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch (error) {
    // `ps -p` exits 1 with no output when nothing matched: the process is gone.
    const { status, stdout } = error as { status?: number; stdout?: Buffer };
    if (status === 1 && (stdout?.length ?? 0) === 0) return undefined;
    throw error;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
