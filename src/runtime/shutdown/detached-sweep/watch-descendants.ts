/** Records original leader-group members and linked detached helpers (PRD §5.3, C-LIFE-10). */
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import type { LeaderObservation } from "./leader-observation.ts";
import { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

/** Each native table read has the existing detached-walk budget. */
export const RECORD_READ_MS = DETACHED_SWEEP_BUDGET_MS;
/** One second limits scans during a five-second grace window to a few; verification is immediate. */
export const RECORD_INTERVAL_MS = 1_000;

/** A recording in progress. */
export type DescendantWatch = {
  readonly record: DescendantRecord;
  /** Settles once the first read has finished, whether or not it succeeded. */
  readonly firstRead: Promise<void>;
  /** Eligible original identity, already gone, or permanently refused. */
  readonly firstObservation: Promise<LeaderObservation>;
  /** Stops reading once the read in flight settles, and resolves to the record. */
  readonly finish: () => Promise<DescendantRecord>;
};

/**
 * Records original leader-group members and linked detached helpers until `finish` or
 * leader exit. Codex's daemon is marked under `leaderPid` and excluded from owned cleanup.
 * Failed later reads retain uncertainty even after readable snapshots. An initial refusal
 * ends observation, so a replacement cannot establish a new baseline.
 */
export function watchDescendants(
  leaderPid: number,
  ops: Pick<SweepOps, "listProcesses">,
  leaderExited: () => boolean,
): DescendantWatch {
  const record = new DescendantRecord();
  let watching = true;
  const scope = daemonScope(new Set([leaderPid]));
  const readOnce = () => {
    const started = Date.now();
    return ops.listProcesses(RECORD_READ_MS, scope).then(
      (table) => {
        record.observe(table, leaderPid, started);
        record.observeLeaderGroup(table, leaderPid, started);
      },
      (error: unknown) => record.noteReadFailure(error),
    );
  };
  const started = Date.now();
  const firstObservation = ops.listProcesses(RECORD_READ_MS, scope).then(
    (table) => {
      const observation = record.observeFirst(table, leaderPid, started);
      record.observe(table, leaderPid, started);
      record.observeLeaderGroup(table, leaderPid, started);
      return observation;
    },
    (error: unknown) => record.refuseFirstObservation(error),
  );
  const firstRead = firstObservation.then(() => undefined);
  const finishing = Promise.withResolvers<void>();
  const reading = (async () => {
    const first = await firstObservation;
    if (first.kind !== "observed") return;
    while (!leaderExited()) {
      // Bound full-table scan frequency; finish cancels the wait and its referenced timer.
      const waiting = Promise.withResolvers<void>();
      const timer = setTimeout(waiting.resolve, RECORD_INTERVAL_MS);
      await Promise.race([waiting.promise, finishing.promise]);
      clearTimeout(timer);
      if (!watching || leaderExited()) return;
      await readOnce();
    }
  })();
  return {
    record,
    firstRead,
    firstObservation,
    finish: async () => {
      watching = false;
      finishing.resolve();
      await reading;
      return record;
    },
  };
}
