/**
 * Pid probes and last-resort cleanup for real-process tests (PRD §5.3 and §9.4,
 * C-LIFE-10). A pid is just a number the OS can reuse once its process is reaped, so a
 * test signals what it owns through a handle it holds wherever it can, and treats a
 * bare pid as a probe target only. `killIfCommandHas` is the fallback for a process no
 * handle reaches any more: it narrows, but cannot close, the window between reading a
 * pid's command line and signaling it.
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
export function killIfCommandHas(pid: number, marker: string): void {
  if (!commandOf(pid)?.includes(marker)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It exited between the read and the kill.
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
