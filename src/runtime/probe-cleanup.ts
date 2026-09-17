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

const cleanupWindowMs = 1_000;
const cleanupRetryMs = 25;
const deferredRetryMs = 1_000;
const retained = new Set<ProbeReaper>();
let retryTimer: ReturnType<typeof setInterval> | undefined;

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
  const reaper = new ProbeReaper(child, pid);
  const deadline = Date.now() + cleanupWindowMs;
  do {
    if (reaper.reap()) return reaper.errorCode ? { cleanupErrorCode: reaper.errorCode } : {};
    await delay(cleanupRetryMs);
  } while (Date.now() < deadline);
  // Every failed probe retains cleanup ownership; update leases additionally
  // preserve exclusion after parent exit. Neither keeps the event loop pinned.
  child.unref();
  retained.add(reaper);
  retryTimer ??= setInterval(reapRetained, deferredRetryMs);
  retryTimer.unref();
  return { cleanupErrorCode: reaper.errorCode ?? "ETIMEDOUT", cleanupProcessGroup: pid };
}

/** Observe normal updater completion without signaling its remaining descendants. */
export async function waitForProbeGroup(pid: number): Promise<boolean> {
  const deadline = Date.now() + cleanupWindowMs;
  do {
    await delay(cleanupRetryMs);
    if (processGroupGone(pid)) return true;
  } while (Date.now() < deadline);
  return false;
}

/** Successful SIGKILL latches signal ownership; later polls only confirm disappearance. */
class ProbeReaper {
  errorCode: ProbeCleanup["cleanupErrorCode"];
  private signaled = false;
  private readonly child: ChildProcess;
  private readonly pid: number;
  constructor(child: ChildProcess, pid: number) {
    this.child = child;
    this.pid = pid;
  }

  reap(): boolean {
    if (processGroupGone(this.pid)) return true;
    if (this.signaled) return false;
    try {
      process.kill(-this.pid, "SIGKILL");
      this.signaled = true;
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return true;
      this.errorCode = boundedErrorToken(error, isReapErrorCode);
      // The native handle targets the direct child even when group signaling fails.
      this.child.kill("SIGKILL");
    }
    return false;
  }
}

function reapRetained(): void {
  for (const reaper of retained) if (reaper.reap()) retained.delete(reaper);
  if (retained.size === 0) {
    clearInterval(retryTimer);
    retryTimer = undefined;
  }
}
