/**
 * Liveness checks and owned-only cleanup for real-process tests (PRD §5.3 and §9.4,
 * C-LIFE-10). A pid is just a number the OS can reuse once its process is reaped, so
 * cleanup kills a pid only while its command line still carries a marker unique to the
 * test that started it, such as that test's own temp directory.
 */

import { execFileSync } from "node:child_process";

/** Whether `pid` exists (an unreaped zombie counts). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone, for up to `timeoutMs`. */
export async function pollGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += 20) {
    if (!isAlive(pid)) return true;
    await delay(20);
  }
  return false;
}

/** `pid`'s command line as `ps` prints it, or `""` once it is gone. */
export function commandOf(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)])
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** SIGKILLs `pid` only while its command line still contains `marker`. */
export function killIfCommandHas(pid: number, marker: string): void {
  if (!commandOf(pid).includes(marker)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It exited between the check and the kill.
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
