/** Records a live leader’s tree until graceful exit, retaining first-read identity (C-LIFE-10). */
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
/** A recording in progress. */
export type DescendantWatch = {
  readonly record: DescendantRecord;
  readonly leaderIdentity: string | undefined;
  /** Settles to whether the first read showed the leader gone; false for a failed read. */
  readonly firstRead: Promise<boolean>;
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
  const readOnce = (beforeSignal = false) => {
    const readStartedAtEpochMs = Date.now();
    return ops.listProcesses(RECORD_READ_MS, scope).then(
      (table) => record.observe(table, leaderPid, beforeSignal, undefined, readStartedAtEpochMs),
      () => undefined,
    );
  };
  let firstIdentity: string | undefined;
  const firstRead = readOnce(true).then(() => {
    firstIdentity = record.leaderIdentity;
    return record.leaderGone;
  });
  const finishing = Promise.withResolvers<void>();
  const reading = (async () => {
    await firstRead;
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
    firstRead,
    finish: async () => {
      watching = false;
      finishing.resolve();
      await reading;
      return record;
    },
  };
}
