/** Identity-bound PTY descendant cleanup, sparing shared Codex daemons (PRD §9.4, C-LIFE-10/14). */

import { toError } from "../../core/errors.ts";
import { sweepDetachedGroups } from "./detached-sweep/index.ts";
import { DescendantRecord } from "./detached-sweep/record.ts";
import { RetainedShutdownFailures } from "./detached-sweep/retained-failures.ts";
import {
  completedSurvivorWatch,
  type SurvivorWatch,
  watchSurvivors,
} from "./detached-sweep/survivor-watch.ts";
import { isReapableGroupId, reapProcessGroup } from "./leader-group.ts";
import { withLeaderGroupDisappearanceGuard } from "./leader-group-evidence.ts";
import { mergeSweepErrors } from "./merge-sweep-errors.ts";
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
/** Completion retires numeric signals; only the termination owner confirms PTY exit. */
export class SessionReaper {
  private readonly leaderPid: number;
  private readonly ops: ProcessTreeOps;
  private done = false;
  private pendingSweeps = 0;
  private gracefulWatch: SurvivorWatch | undefined;
  private gracefulCleanupFinished = false;
  private leaderVerificationPending = false;
  private leaderSignalAuthorizationError: Error | undefined;
  private leaderGroupGone = false;
  private leaderReapError: Error | undefined;
  private readonly detachedSweepQueue = new SerialDetachedSweepQueue();
  private readonly retainedFailures: RetainedShutdownFailures;
  constructor(leaderPid: number, ops: ProcessTreeOps = activeProcessTreeOps()) {
    this.leaderPid = leaderPid;
    this.ops = withLeaderGroupDisappearanceGuard(
      leaderPid,
      ops,
      () => this.leaderGroupGone,
      () => {
        this.leaderGroupGone = true;
        this.leaderVerificationPending = false;
      },
    );
    this.retainedFailures = new RetainedShutdownFailures(this.ops, (attempt) =>
      this.detachedSweepQueue.run(attempt),
    );
  }

  /** Numeric reap stays retryable after syscall failure, never after an ownership veto. */
  reap(): void {
    if (this.done || this.leaderGroupGone || this.pendingSweeps > 0) return;
    this.assertLeaderSignalsAllowed();
    if (this.gracefulWatch !== undefined) return;
    try {
      reapProcessGroup(this.leaderPid, this.ops);
      this.leaderReapError = undefined;
      this.done = true;
    } catch (error) {
      this.leaderReapError = toError(error);
      throw error;
    }
  }

  /** Dispatch a PTY signal only while this session has not confirmed its group gone. */
  signalLeaderPty(send: () => void): LeaderPtySignalOutcome {
    if (this.leaderGroupGone || this.done) {
      this.retainedFailures.throwIfUnresolved();
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
      return completedSurvivorWatch(() => this.retainedFailures.throwIfUnresolved());
    }
    if (pid !== undefined) {
      this.assertLeaderSignalsAllowed();
      this.leaderVerificationPending = true;
    }
    this.gracefulWatch = watchSurvivors(
      pid,
      this.ops,
      leaderExited,
      (failure, record) => {
        this.gracefulCleanupFinished = true;
        let previous: unknown;
        try {
          this.retainedFailures.throwIfUnresolved();
        } catch (error) {
          previous = error;
        }
        if (this.leaderSignalAuthorizationError !== undefined)
          record.markLeaderAuthorityLost(this.leaderPid);
        if (this.leaderGroupGone) record.markGroupGone(this.leaderPid);
        try {
          this.retainedFailures.keep(failure, record);
        } catch (error) {
          throw mergeSweepErrors(previous, error);
        }
        this.retainedFailures.throwIfUnresolved();
        this.assertNoAuthorizationFailure();
        this.done = true;
      },
      {
        serialize: (attempt) => this.detachedSweepQueue.run(attempt),
        assertRetainedAuthority: () => {
          this.assertNoAuthorizationFailure();
          this.retainedFailures.throwIfUnresolved();
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

  /** Retained-history retries confirm evidence without restarting numeric leader signals. */
  reapAndThrowOnDetachedSweepFailure(): void | Promise<void> {
    if (!this.retainedFailures.hasRetainedHistory) return this.reap();
    if (this.leaderReapError !== undefined) this.forbidLeaderSignals(this.leaderReapError);
    const confirmation = this.retainedFailures.confirm();
    const finish = () => {
      this.assertNoAuthorizationFailure();
      this.retainedFailures.throwIfUnresolved();
    };
    if (confirmation !== undefined) return confirmation.then(finish);
    finish();
  }

  /** Join graceful cleanup, or walk a live leader before forced termination.
   * A gone group still joins unfinished restoration; completed cleanup never restarts ancestry. */
  async sweepDetached(leaderExited: () => boolean): Promise<void> {
    const cleanupComplete = this.done || (this.leaderGroupGone && this.gracefulCleanupFinished);
    if (cleanupComplete) return;
    if (this.gracefulWatch !== undefined) return this.gracefulWatch.reap();
    if (!isReapableGroupId(this.leaderPid)) return;
    this.pendingSweeps += 1;
    try {
      const record = new DescendantRecord();
      const failure = await this.detachedSweepQueue.run(() => {
        // A queued request must recheck after the preceding pass has confirmed exit.
        if (this.leaderGroupGone || this.done) return Promise.resolve(undefined);
        this.assertLeaderSignalsAllowed();
        return sweepDetachedGroups(
          this.leaderPid,
          this.ops,
          leaderExited,
          undefined,
          () => {
            this.leaderGroupGone = true;
          },
          record,
        );
      });
      this.retainedFailures.keep(failure, record);
    } finally {
      this.pendingSweeps -= 1;
    }
  }
}
