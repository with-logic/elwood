/** Owns graceful recording, held-leader signaling, and retained survivor failures (C-LIFE-10). */
import type { ReapQueue } from "../reap-queue.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import { type LeaderSignalOutcome, sendHeldLeaderSignal } from "./held-leader.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";
import { type LeaderObservation, watchDescendants } from "./watch-descendants.ts";

/** A graceful stop's watch for survivors, from the first recording read to the reap. */
export type SurvivorWatch = {
  /** Exact first-read observation; a failed read does not authorize any signal. */
  readonly firstObservation: Promise<LeaderObservation>;
  /** Distinguishes a verified signal from cancellation because the leader was gone. */
  readonly sendSignal: (send: () => void) => Promise<LeaderSignalOutcome>;
  /**
   * Stops recording, then, if `leaderExited` reports the exit, reaps the recorded
   * processes still alive and hands the outcome, a failure or `undefined`, to `keep`
   * with the record. A failed termination without a confirmed exit retains a failure
   * instead of discarding that record.
   */
  readonly finish: (failedTermination?: boolean) => Promise<void>;
};

/**
 * Records `leaderPid`'s detached descendants (`watchDescendants`) until `finish`. Records
 * nothing for an `undefined` leader, one whose id the group reap refuses.
 */
export function watchSurvivors(
  leaderPid: number | undefined,
  ops: SweepOps,
  leaderExited: () => boolean,
  keep: (failure: SweepFailure | undefined, record: DescendantRecord) => void,
  reap: typeof reapRecordedSurvivors = reapRecordedSurvivors,
  guard: ReapQueue = (attempt) => attempt(),
  forbidLeaderSignals: (error: unknown) => void = () => {
    /* Standalone watches have no later leader reap. */
  },
): SurvivorWatch {
  if (leaderPid === undefined)
    return {
      firstObservation: Promise.resolve("leader-gone"),
      sendSignal: () => Promise.resolve("leader-gone"),
      finish: () => Promise.resolve(),
    };
  const deadline = performance.now() + DETACHED_SWEEP_BUDGET_MS;
  const watch = watchDescendants(leaderPid, ops, leaderExited);
  return {
    firstObservation: watch.firstObservation,
    sendSignal: (send) => {
      const identity = watch.leaderIdentity;
      const firstReadFailure = watch.firstReadFailure;
      return guard(() =>
        sendHeldLeaderSignal({
          pid: leaderPid,
          record: watch.record,
          identity,
          firstReadFailure,
          forbidLeaderSignals,
          ops,
          leaderExited,
          deadline,
          send,
        }),
      );
    },
    finish: async (failedTermination = false) => {
      const record = await watch.finish();
      if (leaderExited()) keep(await reap(record, ops), record);
      else if (failedTermination) {
        const failures = new SweepFailures();
        failures.record("the leader's exit was not confirmed", undefined, []);
        keep(failures.result(), record);
      }
    },
  };
}
