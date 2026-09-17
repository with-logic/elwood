/**
 * Bounded process-group termination and direct-child reaping for aborted probes.
 * Implements PRD §9.2 / C-PERF-03; unresolved groups retain update exclusion.
 */
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { errnoCode } from "../core/errors.ts";
import {
  boundedErrorToken,
  isReapErrorCode,
  type ReapErrorCode,
} from "../core/warnings/reasons.ts";

export type ProbeCleanup = {
  readonly cleanupErrorCode?: ReapErrorCode | "ETIMEDOUT";
  readonly cleanupProcessGroup?: number;
};

export function processGroupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

export async function abortProbe(child: ChildProcess): Promise<ProbeCleanup> {
  // Abort only follows timeout/output from a successfully spawned process.
  const pid = child.pid!;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  const deadline = Date.now() + 1_000;
  let cleanupErrorCode: ProbeCleanup["cleanupErrorCode"];
  do {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (errnoCode(error) !== "ESRCH") {
        cleanupErrorCode = boundedErrorToken(error, isReapErrorCode);
      }
      // A failed group signal must not leave the direct child unowned. The
      // ChildProcess API signals its native handle rather than process.kill.
      child.kill("SIGKILL");
    }
    await delay(25);
    if (child.exitCode !== null || child.signalCode !== null) {
      if (processGroupGone(pid)) return cleanupErrorCode ? { cleanupErrorCode } : {};
    }
  } while (Date.now() < deadline);
  // The durable update lease, when present, takes ownership of this group.
  // A surviving subprocess must not keep the parent event loop pinned.
  child.unref();
  return { cleanupErrorCode: cleanupErrorCode ?? "ETIMEDOUT", cleanupProcessGroup: pid };
}
