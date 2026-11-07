/** Private graceful recording, held signaling and retained outcomes (PRD §5.3, C-LIFE-10). */
import { type SweepFailure, SweepFailures } from "./failures.ts";
import {
  type LeaderSignalGuard,
  type LeaderSignalOutcome,
  sendHeldLeaderSignal,
} from "./held-leader.ts";
import type { LeaderObservation } from "./leader-observation.ts";
import { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";
import { RECORD_READ_MS, watchDescendants } from "./watch-descendants.ts";

export type SurvivorWatch = {
  /** Settles after the first observation attempt, including refusal or a missing target. */
  readonly firstRead: Promise<void>;
  /** Freezes the first read's evidence; a missing target settles immediately as refused. */
  readonly firstObservation: Promise<LeaderObservation>;
  readonly sendSignal: (send: () => void) => Promise<LeaderSignalOutcome>;
  /** Stop recording; true retains failure and record if termination failed before exit. */
  readonly finish: (failedTermination?: boolean) => Promise<void>;
};

/** Keep first-read authority and the original deadline through queued signal admission. */
export function watchSurvivors(
  leaderPid: number | undefined,
  ops: SweepOps,
  leaderExited: () => boolean,
  keep: (failure: SweepFailure | undefined, record: DescendantRecord) => void,
  guard: LeaderSignalGuard,
): SurvivorWatch {
  if (leaderPid === undefined) {
    const error = new Error("No safe leader signal target.");
    const record = new DescendantRecord();
    guard.forbid(error);
    return {
      firstRead: Promise.resolve(),
      firstObservation: Promise.resolve({ kind: "refused", error }),
      sendSignal: () => Promise.reject(error),
      finish: (failedTermination = false) =>
        Promise.resolve().then(() => {
          if (!failedTermination) return;
          const failures = new SweepFailures();
          failures.record("no read showed the leader's tree", error, []);
          keep(failures.result(), record);
        }),
    };
  }
  const deadline = performance.now() + RECORD_READ_MS;
  const watch = watchDescendants(leaderPid, ops, leaderExited);
  let groupGone = false;
  const firstObservation = watch.firstObservation.then((observation) => {
    if (observation.kind === "refused") guard.forbid(observation.error);
    else if (observation.kind === "gone")
      guard.forbid(new Error("No original leader before SIGTERM."));
    return observation;
  });
  return {
    firstRead: firstObservation.then(() => undefined),
    firstObservation,
    sendSignal: (send) =>
      sendHeldLeaderSignal({
        pid: leaderPid,
        record: watch.record,
        observation: firstObservation,
        ops,
        leaderExited,
        deadline,
        guard,
        send,
      }).then((outcome) => {
        groupGone = outcome === "leader-group-gone";
        return outcome;
      }),
    finish: async (failedTermination = false) => {
      const record = await watch.finish();
      if (groupGone || leaderExited())
        keep(await guard.serialize(() => reapRecordedSurvivors(record, ops)), record);
      else {
        const failures = new SweepFailures();
        record.includeReadFailure(failures);
        if (failedTermination)
          failures.record("the leader's exit was not confirmed", undefined, []);
        const failure = failures.result();
        if (failure !== undefined) keep(failure, record);
      }
    },
  };
}
