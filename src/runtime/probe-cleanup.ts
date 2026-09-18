/**
 * Process-group liveness and bounded termination for aborted probes.
 * Implements PRD §9.2 / C-PERF-03 and C-PERF-04: an aborted probe's cleanup is bounded,
 * a reissued group id is never signaled, and a surviving updater group retains exclusion.
 */
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { errnoCode } from "../core/errors.ts";
import {
  boundedErrorToken,
  isReapErrorCode,
  type ReapErrorCode,
} from "../core/warnings/reasons.ts";

/**
 * Unconfirmed cleanup names both the reason and the group still outstanding; confirmed
 * cleanup names neither. Both fields are optional because `CommandResult` intersects this
 * into an error shape that exists for every failed probe, not only aborted ones — the two
 * are nevertheless always written together, by `abortProbe` alone.
 */
export type ProbeCleanup = {
  readonly cleanupErrorCode?: ReapErrorCode | "ETIMEDOUT";
  readonly cleanupProcessGroupId?: number;
};

const cleanupWindowMs = 1_000;
const groupOnlyRetryMs = 500;
const cleanupRetryMs = 25;
const deferredRetryMs = 1_000;
const retained = new Set<ProbeReaper>();
let retryTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Whether a process group has fully exited. Signal 0 delivers nothing — it only asks the
 * kernel whether the group could be signaled — so observing a group can never disturb it.
 * Only `ESRCH` proves absence: any other error (notably `EPERM`, a group this user may not
 * signal) means something is still there, so the group counts as live and the lease it
 * holds is kept. Guessing "gone" here would let a second updater run against a live one.
 */
export function processGroupGone(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

/**
 * Observes an aborted updater's groups for a short window without signaling them, and
 * returns those still live. A group that exits on its own in that window never retains the
 * lease, so an update whose descendants are merely slow to finish costs one second rather
 * than a lease the next host has to wait out.
 */
export async function waitForProbeGroups(
  processGroupIds: readonly number[],
): Promise<readonly number[]> {
  // Monotonic, like the abort window it mirrors: this is a promised bound on how long a
  // start is delayed, so a backward system-clock adjustment must not extend it, nor a
  // forward one cut the observation short and hand the lease over early.
  const deadline = performance.now() + cleanupWindowMs;
  let live = processGroupIds.filter((id) => !processGroupGone(id));
  while (live.length > 0 && performance.now() < deadline) {
    await delay(cleanupRetryMs);
    live = live.filter((id) => !processGroupGone(id));
  }
  return live;
}

export async function abortProbe(child: ChildProcess): Promise<ProbeCleanup> {
  // Abort only follows timeout/output from a successfully spawned process, and
  // a detached child leads the process group named by its own pid.
  const processGroupId = child.pid!;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  // Nothing in the cleanup window may prolong host shutdown: not the child handle, and
  // not the retry timers. The window is measured on a clock that cannot be adjusted.
  child.unref();
  const reaper = new ProbeReaper(child, processGroupId);
  const started = performance.now();
  for (;;) {
    const elapsedMs = performance.now() - started;
    // Past the window this is an observation, never a signal: a loaded event loop can
    // resume this loop late, and the bound is a promise about when Elwood stops signaling,
    // not merely about when it stops waiting.
    if (elapsedMs >= cleanupWindowMs) {
      if (processGroupGone(processGroupId)) return {};
      break;
    }
    // Confirmed cleanup is not a failure, whichever signal achieved it.
    if (reaper.reap(elapsedMs >= groupOnlyRetryMs)) return {};
    await delay(cleanupRetryMs, undefined, { ref: false });
  }
  // Only an UNRESOLVED abort gets here — confirmed cleanup has already returned above — and
  // it is what retains cleanup ownership; update leases additionally preserve exclusion
  // after parent exit. Neither keeps the event loop pinned.
  retained.add(reaper);
  retryTimer ??= setInterval(reapRetained, deferredRetryMs);
  retryTimer.unref();
  return {
    cleanupErrorCode: reaper.errorCode ?? "ETIMEDOUT",
    cleanupProcessGroupId: processGroupId,
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
  private leaderReaped = false;
  private child: ChildProcess | undefined;
  private readonly processGroupId: number;
  constructor(child: ChildProcess, processGroupId: number) {
    this.child = child;
    this.processGroupId = processGroupId;
  }

  reap(fallBackToLeader = true): boolean {
    if (processGroupGone(this.processGroupId)) return true;
    // Reaped is terminal, so it is latched and the handle dropped: from here the id can be
    // reissued and is only ever observed, and a reaper waiting out a long-lived descendant
    // has no further use for the child, its streams, or the closures they hold.
    if (
      this.child !== undefined &&
      (this.child.exitCode !== null || this.child.signalCode !== null)
    ) {
      this.leaderReaped = true;
      this.child = undefined;
    }
    if (this.signaled || this.leaderReaped || this.child === undefined) return false;
    try {
      process.kill(-this.processGroupId, "SIGKILL");
      this.signaled = true;
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return true;
      this.errorCode = boundedErrorToken(error, isReapErrorCode);
      // The native handle targets the direct child even when group signaling fails, so
      // it starts only after the group-only phase. Group retries continue beside it
      // until the leader is observed reaped, after which the id is never signaled.
      if (fallBackToLeader) this.child?.kill("SIGKILL");
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
