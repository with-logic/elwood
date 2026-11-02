/** Records a live leader’s tree until graceful exit, retaining first-read identity (C-LIFE-10). */
import { errnoCode, isErrnoToken } from "../../../core/errors.ts";
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

/**
 * Each read's bound, the one before the SIGTERM included: the walk's own deadline. A read
 * cut short records nothing, and on a loaded host one read, with Codex's daemon path
 * reads, can take over a second (docs/cli-behavior.md), so a one-second bound there
 * recorded nothing at all and left the leader's tree unknown. Only a `ps` that never
 * answers holds the SIGTERM back for the whole bound.
 */
export const RECORD_READ_MS = DETACHED_SWEEP_BUDGET_MS;
export type LeaderObservation = "leader-gone" | "leader-observed" | "read-failed";

/** A recording in progress. */
export type DescendantWatch = {
  readonly record: DescendantRecord;
  readonly leaderIdentity: string | undefined;
  /** Exact first-read observation; later reads never replace its authority or failure. */
  readonly firstObservation: Promise<LeaderObservation>;
  readonly firstReadFailure: Error | undefined;
  /** Stops reading once the read in flight settles, and resolves to the record. */
  readonly finish: () => Promise<DescendantRecord>;
};

/**
 * Reads the table again and again, with Codex's daemon marked under `leaderPid`, recording
 * the leader's detached descendants until `finish` is called or `leaderExited` reports the
 * exit. A failed read records nothing and the next one follows.
 */
export function watchDescendants(
  leaderPid: number,
  ops: Pick<SweepOps, "listProcesses">,
  leaderExited: () => boolean,
): DescendantWatch {
  const record = new DescendantRecord();
  let watching = true;
  const scope = daemonScope(new Set([leaderPid]));
  let firstReadFailure: Error | undefined;
  const readOnce = (beforeSignal = false) => {
    const readStartedAtEpochMs = Date.now();
    return ops.listProcesses(RECORD_READ_MS, scope).then(
      (table) => record.observe(table, leaderPid, beforeSignal, undefined, readStartedAtEpochMs),
      (error: unknown) => {
        if (beforeSignal) {
          const code = errnoCode(error);
          firstReadFailure = Object.assign(
            new Error("First leader process-table read failed."),
            isErrnoToken(code) ? { code } : {},
          );
        }
      },
    );
  };
  let firstIdentity: string | undefined;
  const firstObservation: Promise<LeaderObservation> = readOnce(true).then(() => {
    firstIdentity = record.leaderIdentity;
    return firstReadFailure ? "read-failed" : record.leaderGone ? "leader-gone" : "leader-observed";
  });
  const finishing = Promise.withResolvers<void>();
  const reading = (async () => {
    await firstObservation;
    while (!leaderExited()) {
      // Lets the exit be observed between reads; a `finish` ends the wait at once.
      await Promise.race([new Promise((resolve) => setImmediate(resolve)), finishing.promise]);
      if (!watching || leaderExited()) return;
      await readOnce();
    }
  })();
  return {
    record,
    get leaderIdentity() {
      return firstIdentity;
    },
    firstObservation,
    get firstReadFailure() {
      return firstReadFailure;
    },
    finish: async () => {
      watching = false;
      finishing.resolve();
      await reading;
      return record;
    },
  };
}
