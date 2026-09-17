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
const groupOnlyRetryMs = 500;
const cleanupRetryMs = 25;
const deferredRetryMs = 1_000;
const retained = new Set<ProbeReaper>();
let retryTimer: ReturnType<typeof setInterval> | undefined;

export function processGroupGone(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

export async function abortProbe(child: ChildProcess): Promise<ProbeCleanup> {
  // Abort only follows timeout/output from a successfully spawned process, and
  // a detached child leads the process group named by its own pid.
  const processGroupId = child.pid!;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  const reaper = new ProbeReaper(child, processGroupId);
  const started = Date.now();
  do {
    // Confirmed cleanup is not a failure, whichever signal achieved it.
    if (reaper.reap(Date.now() - started >= groupOnlyRetryMs)) return {};
    await delay(cleanupRetryMs);
  } while (Date.now() - started < cleanupWindowMs);
  // Every failed probe retains cleanup ownership; update leases additionally
  // preserve exclusion after parent exit. Neither keeps the event loop pinned.
  child.unref();
  retained.add(reaper);
  retryTimer ??= setInterval(reapRetained, deferredRetryMs);
  retryTimer.unref();
  return {
    cleanupErrorCode: reaper.errorCode ?? "ETIMEDOUT",
    cleanupProcessGroup: processGroupId,
  };
}

/**
 * A process-group id is provably ours only while Node has not reaped the group's
 * leader: the unreaped pid cannot be reissued, so no unrelated group can take the
 * number. After that the id may be recycled, so the reaper only observes it. A
 * successful SIGKILL also latches; later polls only confirm disappearance.
 */
class ProbeReaper {
  errorCode: ProbeCleanup["cleanupErrorCode"];
  private signaled = false;
  private readonly child: ChildProcess;
  private readonly processGroupId: number;
  constructor(child: ChildProcess, processGroupId: number) {
    this.child = child;
    this.processGroupId = processGroupId;
  }

  reap(fallBackToLeader = true): boolean {
    if (processGroupGone(this.processGroupId)) return true;
    const leaderReaped = this.child.exitCode !== null || this.child.signalCode !== null;
    if (this.signaled || leaderReaped) return false;
    try {
      process.kill(-this.processGroupId, "SIGKILL");
      this.signaled = true;
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return true;
      this.errorCode = boundedErrorToken(error, isReapErrorCode);
      // The native handle targets the direct child even when group signaling
      // fails. It also ends group retries, so it waits out the retry-only phase.
      if (fallBackToLeader) this.child.kill("SIGKILL");
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
