/**
 * Reaps the process tree of a PTY leader on session teardown, but Codex's shared
 * app-server daemon, its updater, and what they started (`shared-daemon.ts`).
 * Implements PRD §5.3 and §9.4 (C-LIFE-10): a CLI-spawned helper such as the
 * Claude hook bridge is a descendant of the PTY leader. Because POSIX reparents
 * a surviving descendant to PID 1 the instant its parent exits, a parent-pid
 * walk (`pgrep -P`) cannot find it afterwards — but node-pty starts the leader
 * as its own session/process-group leader, and group membership is inherited
 * and survives reparenting. So we reap by SIGKILLing the leader's process group,
 * which reaches every descendant still IN that group in one in-process syscall: no
 * subprocess, no PATH lookup, no post-exit reparenting blind spot.
 *
 * A descendant that started its own group is outside it: Claude and Codex start every
 * hook with `setsid()` (docs/cli-behavior.md, "Hook and MCP process groups").
 * `sweepDetached` finds those groups by parent pid and kills them, all but the daemon's
 * and its updater's, which other Codex sessions share, so it has to run
 * while that link still exists: before the live leader is SIGKILLed (see
 * `sweepDetachedGroups` in `detached-sweep/index.ts`). Graceful shutdown records those
 * links before TERM and verifies recorded survivors after exit (`watchSurvivors`).
 */

import { toError } from "../../core/errors.ts";
import type { SweepFailure } from "./detached-sweep/failures.ts";
import { sweepDetachedGroups } from "./detached-sweep/index.ts";
import {
  completedSurvivorWatch,
  type SurvivorWatch,
  watchSurvivors,
} from "./detached-sweep/survivor-watch.ts";
import { isReapableGroupId, reapProcessGroup } from "./leader-group.ts";
import { activeProcessTreeOps, type ProcessTreeOps } from "./process-tree-ops.ts";
import { SerialDetachedSweepQueue } from "./reap-queue.ts";

export { reapProcessGroup } from "./leader-group.ts";
export {
  osProcessTreeOps,
  type ProcessTreeOps,
  quietProcessTree,
  resetProcessTreeOpsForTests,
  rethrowUnlessGroupGone,
  setProcessTreeOpsForTests,
} from "./process-tree-ops.ts";

export type LeaderPtySignalOutcome = "signal-sent" | "leader-group-gone";

/**
 * Owns one successful group cleanup: a numeric forced reap or a verified graceful walk.
 * Completion prevents another numeric kill after PID reuse; it does not prove that
 * node-pty delivered exit. The termination owner separately awaits that observation.
 * Syscall reap failures stay retryable; an ownership veto permanently blocks later
 * leader signals. Graceful cleanup retains its original record and first outcome.
 */
export class SessionReaper {
  private readonly leaderPid: number;
  private readonly ops: ProcessTreeOps;
  private done = false;
  private pendingSweeps = 0;
  private gracefulWatch: SurvivorWatch | undefined;
  private leaderVerificationPending = false;
  private leaderSignalAuthorizationError: Error | undefined;
  /** Terminal evidence about the entire group, never inferred merely from leader exit. */
  private leaderGroupGone = false;
  private readonly detachedSweepQueue = new SerialDetachedSweepQueue();
  /** A detached sweep that failed; once the leader is gone it can never be confirmed. */
  private unresolvedSweep: SweepFailure | undefined;

  constructor(leaderPid: number, ops: ProcessTreeOps = activeProcessTreeOps()) {
    this.leaderPid = leaderPid;
    this.ops = ops;
  }

  /**
   * Reap the group once it succeeds; a successful call latches so subsequent
   * calls no-op (no recycled-pgid double-kill). A failed kill does NOT latch and
   * rethrows, keeping syscall failures retryable. An ownership veto permanently blocks
   * later leader signals, including retries from a lifecycle call.
   */
  reap(): void {
    // The active shutdown owner reaps after its sweep, including any pending confirmation.
    if (this.done || this.leaderGroupGone || this.pendingSweeps > 0) return;
    this.assertLeaderSignalsAllowed();
    if (this.gracefulWatch !== undefined) return;
    reapProcessGroup(this.leaderPid, this.ops);
    this.done = true;
  }

  /** Dispatch a PTY signal only while this session has not confirmed its group gone. */
  signalLeaderPty(send: () => void): LeaderPtySignalOutcome {
    if (this.leaderGroupGone || this.done) {
      this.reapAndThrowOnDetachedSweepFailure();
      return "leader-group-gone";
    }
    this.assertLeaderSignalsAllowed();
    if (this.gracefulWatch !== undefined)
      throw new Error("Graceful shutdown owns verified leader-group cleanup.");
    send();
    return "signal-sent";
  }

  /** Verify graceful authority before any exit callback can reap the numeric leader group. */
  watchSurvivors(leaderExited: () => boolean): SurvivorWatch {
    if (this.gracefulWatch !== undefined) return this.gracefulWatch;
    const pid = isReapableGroupId(this.leaderPid) ? this.leaderPid : undefined;
    if (pid !== undefined && (this.done || this.leaderGroupGone)) {
      return completedSurvivorWatch(() => this.reapAndThrowOnDetachedSweepFailure());
    }
    if (pid !== undefined) {
      this.assertLeaderSignalsAllowed();
      this.leaderVerificationPending = true;
    }
    this.gracefulWatch = watchSurvivors(
      pid,
      this.ops,
      leaderExited,
      (failure) => {
        if (failure !== undefined) this.unresolvedSweep = failure;
        if (this.unresolvedSweep !== undefined) throw this.unresolvedSweep;
        this.assertNoAuthorizationFailure();
        this.done = true;
      },
      {
        serialize: (attempt) => this.detachedSweepQueue.run(attempt),
        assertRetainedAuthority: () => {
          this.assertNoAuthorizationFailure();
          if (this.unresolvedSweep !== undefined) throw this.unresolvedSweep;
        },
        authorize: () => {
          this.assertNoAuthorizationFailure();
          this.leaderVerificationPending = false;
        },
        forbid: (error) => this.forbidLeaderSignals(error),
        gone: () => {
          this.leaderGroupGone = true;
          this.leaderVerificationPending = false;
        },
      },
    );
    return this.gracefulWatch;
  }

  private forbidLeaderSignals(error: unknown): void {
    this.leaderSignalAuthorizationError ??= toError(error);
    this.leaderVerificationPending = false;
  }

  private assertNoAuthorizationFailure(): void {
    if (this.leaderSignalAuthorizationError !== undefined)
      throw this.leaderSignalAuthorizationError;
  }

  private assertLeaderSignalsAllowed(): void {
    if (this.leaderVerificationPending)
      this.forbidLeaderSignals(
        new Error("The leader exited before signal ownership was verified."),
      );
    this.assertNoAuthorizationFailure();
  }

  /**
   * Synchronous failure check, not an owner of the asynchronous graceful wait.
   * ShutdownCoordinator joins/chains explicit shutdown before this check; native exit
   * callbacks only attempt the synchronous reap. Unobserved helpers cannot be discovered.
   */
  reapAndThrowOnDetachedSweepFailure(): void {
    this.reap();
    if (this.unresolvedSweep !== undefined) throw this.unresolvedSweep;
  }

  /**
   * With a graceful owner, joins its retained identity-verified cleanup before or after
   * leader exit. Otherwise uses the legacy live-leader sweep before forced SIGKILL,
   * while parent links can still identify detached descendants. That sweep records
   * failed or unconfirmed groups for the later synchronous failure check and refuses
   * the same unsafe numeric IDs as the group reap.
   */
  async sweepDetached(leaderExited: () => boolean): Promise<void> {
    if (this.gracefulWatch !== undefined) return this.gracefulWatch.reap();
    if (!isReapableGroupId(this.leaderPid)) return;
    this.pendingSweeps += 1;
    try {
      const failure = await this.detachedSweepQueue.run(() => {
        // A queued request must recheck after the preceding pass has confirmed exit.
        if (this.leaderGroupGone || this.done) return Promise.resolve(undefined);
        this.assertLeaderSignalsAllowed();
        return sweepDetachedGroups(this.leaderPid, this.ops, leaderExited, undefined, () => {
          this.leaderGroupGone = true;
        });
      });
      if (failure === undefined) return;
      this.unresolvedSweep = failure;
      throw failure;
    } finally {
      this.pendingSweeps -= 1;
    }
  }
}
