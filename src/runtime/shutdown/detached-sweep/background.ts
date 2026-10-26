/**
 * Keeps reaping, in the background, the detached descendants a failed walk or survivor
 * reap recorded (PRD §5.3, C-LIFE-14). Once the leader is gone nothing links them to the
 * session, and its pid may belong to another process, so the walk is never tried again
 * from it. The processes it recorded are known by pid and start time, though, and a
 * failure that left them running would leave them running for good: the host is told the
 * stop failed and moves on. So each attempt reads the table, and the reap is resolved
 * once a read shows none of them alive; a pid that a process started at another time now
 * holds is none of them. Until then each attempt reaps them by the survivor reap's rules
 * (`survivors.ts`), and the next follows a second later, for a minute at most. Its timers
 * and its reads never keep the host alive. A record with no process in it is never
 * resolved: nothing shows what the failure left running.
 */

import { setTimeout as delay } from "node:timers/promises";
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";

/** How long a failure's recorded processes are reaped in the background. */
export const BACKGROUND_REAP_LIFETIME_MS = 60_000;
/** The pause between one attempt and the next. */
export const BACKGROUND_REAP_RETRY_MS = 1_000;

/** A failure's recorded processes being reaped in the background. */
export type BackgroundReap = {
  /** Whether a read has shown every recorded process gone. */
  readonly resolved: () => boolean;
};

/**
 * Reaps `record`'s processes with `ops`, whose reads must not keep the host alive, until a
 * read shows none of them alive or the lifetime ends.
 */
export function reapInBackground(record: DescendantRecord, ops: SweepOps): BackgroundReap {
  if (record.pids.length === 0) return { resolved: () => false };
  let resolved = false;
  const until = performance.now() + BACKGROUND_REAP_LIFETIME_MS;
  void (async () => {
    while (!(await noneAlive(record, ops))) {
      if (performance.now() >= until) return;
      await reapRecordedSurvivors(record, ops); // A failure is read again by the next attempt.
      await delay(BACKGROUND_REAP_RETRY_MS, undefined, { ref: false });
    }
    resolved = true;
  })();
  return { resolved: () => resolved };
}

/**
 * Whether a read shows none of `record`'s processes alive; a failed read shows nothing.
 * The read has the walk's deadline: on a loaded host one read can take over a second, and
 * a shorter bound would fail every check, so the reap could never resolve.
 */
async function noneAlive(record: DescendantRecord, ops: SweepOps): Promise<boolean> {
  try {
    // Codex's daemon, which a recorded process may have become, is not left to the reap.
    const scope = daemonScope(new Set(record.pids));
    const table = await ops.listProcesses(DETACHED_SWEEP_BUDGET_MS, scope);
    return record.survivors(table).length === 0;
  } catch {
    return false;
  }
}
