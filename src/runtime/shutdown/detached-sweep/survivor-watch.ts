/** Owns graceful recording, held-leader signaling, and retained survivor failures (C-LIFE-10). */
import type { ReapQueue } from "./background.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import { sendHeldLeaderSignal } from "./held-leader.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";
import { watchDescendants } from "./watch-descendants.ts";

/** A graceful stop's watch for survivors, from the first recording read to the reap. */
export type SurvivorWatch = {
  /** Whether the read before SIGTERM showed the leader gone; false for a failed read. */
  readonly firstRead: Promise<boolean>;
  /** Sends only while the original leader is verified stopped; true means it was gone. */
  readonly sendSignal: (send: () => void) => Promise<boolean>;
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
): SurvivorWatch {
  if (leaderPid === undefined)
    return {
      firstRead: Promise.resolve(false),
      sendSignal: () => Promise.resolve(true),
      finish: () => Promise.resolve(),
    };
  const deadline = performance.now() + DETACHED_SWEEP_BUDGET_MS;
  const watch = watchDescendants(leaderPid, ops, leaderExited);
  return {
    firstRead: watch.firstRead,
    sendSignal: (send) => {
      const identity = watch.leaderIdentity;
      return guard(() =>
        sendHeldLeaderSignal({
          pid: leaderPid,
          record: watch.record,
          identity,
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
