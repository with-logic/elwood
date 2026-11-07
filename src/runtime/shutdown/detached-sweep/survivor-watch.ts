/** Private graceful recording, held signaling and retained outcomes (PRD §5.3, C-LIFE-10). */
import { type SweepFailure, SweepFailures } from "./failures.ts";
import {
  type LeaderSignalGuard,
  type LeaderSignalOutcome,
  sendHeldLeaderSignal,
} from "./held-leader.ts";
import type { LeaderObservation } from "./leader-observation.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";
import { RECORD_READ_MS, watchDescendants } from "./watch-descendants.ts";

export type SurvivorWatch = {
  readonly firstRead: Promise<void>;
  readonly firstObservation: Promise<LeaderObservation>;
  readonly sendSignal: (send: () => void) => Promise<LeaderSignalOutcome>;
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
  if (leaderPid === undefined)
    return {
      firstRead: Promise.resolve(),
      firstObservation: Promise.resolve({ kind: "gone" }),
      sendSignal: () => Promise.resolve("leader-group-gone"),
      finish: () => Promise.resolve(),
    };
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
      else if (failedTermination) {
        const failures = new SweepFailures();
        failures.record("the leader's exit was not confirmed", undefined, []);
        keep(failures.result(), record);
      }
    },
  };
}
