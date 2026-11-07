/** Records descendants while preserving immutable first-read authority (PRD §5.3, C-LIFE-10). */
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import type { LeaderObservation } from "./leader-observation.ts";
import { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

/** Each native table read has the existing detached-walk budget. */
export const RECORD_READ_MS = DETACHED_SWEEP_BUDGET_MS;

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
 * Reads the table again and again, with Codex's daemon marked under `leaderPid`, recording
 * the leader's detached descendants until `finish` is called or `leaderExited` reports the
 * exit. A failed later read records nothing and the next one follows. An initial refusal
 * ends the watch, so a replacement cannot establish a new baseline.
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
      (table) => record.observe(table, leaderPid, started),
      () => undefined,
    );
  };
  const started = Date.now();
  const firstObservation = ops.listProcesses(RECORD_READ_MS, scope).then(
    (table) => {
      const observation = record.observeFirst(table, leaderPid, started);
      record.observe(table, leaderPid, started);
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
      // Lets the exit be observed between reads; a `finish` ends the wait at once.
      await Promise.race([new Promise((resolve) => setImmediate(resolve)), finishing.promise]);
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
