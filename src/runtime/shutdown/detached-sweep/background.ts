/**
 * Keeps reaping, in the background, the detached descendants a failed walk or survivor
 * reap recorded (PRD §5.3, C-LIFE-14). Once the leader is gone nothing links them to the
 * session, and its pid may belong to another process, so the walk is never tried again
 * from it. The processes it recorded are known by pid and start time, though, and a
 * failure that left them running would leave them running for good: the host is told the
 * stop failed and moves on. So each attempt reads the table, and the reap is resolved
 * once no recorded non-daemon survivor remains and any failed daemon resume is resolved;
 * a pid now held by a process with another start time is none of them. Until then each
 * attempt reaps them by the survivor reap's rules
 * (`survivors.ts`), and the next follows a second later, for a minute at most. Its timers
 * and its reads never keep the host alive. A record with no process in it is never
 * resolved: nothing shows what the failure left running.
 */

import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";

/** A minute gives transient read/signal failures time to clear without an indefinite watcher. */
export const BACKGROUND_REAP_LIFETIME_MS = 60_000;
/** A one-second pause avoids continuously scanning a loaded host after a failed attempt. */
export const BACKGROUND_REAP_RETRY_MS = 1_000;

/** A failure's recorded processes being reaped in the background. */
export type BackgroundReap = {
  /** Whether no recorded non-daemon survivor or failed daemon resume remains. */
  readonly resolved: () => boolean;
};

/** Serializes a session’s foreground and background signal passes. */
export type ReapQueue = <T>(attempt: () => Promise<T>) => Promise<T>;

/** Retries this record without holding the host alive, within the bounded lifetime. */
export function reapInBackground(
  record: DescendantRecord,
  ops: SweepOps,
  serialize: ReapQueue = (attempt) => attempt(),
): BackgroundReap {
  if (record.pids.length === 0) return { resolved: () => false };
  let resolved = false;
  const until = performance.now() + BACKGROUND_REAP_LIFETIME_MS;
  void (async () => {
    while (!(await serialize(() => attempt(record, ops, until)))) {
      if (performance.now() >= until) return;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_REAP_RETRY_MS).unref());
    }
    resolved = true;
  })();
  return { resolved: () => resolved };
}

/**
 * One retry’s first table read also seeds its survivor reap, avoiding a duplicate scan.
 * Each attempt gets a fresh ten-second timeout, equal to the walk’s budget: one read can
 * take over a second on a loaded host; a shorter bound would fail every retry.
 */
async function attempt(record: DescendantRecord, ops: SweepOps, until: number): Promise<boolean> {
  try {
    // Codex's daemon, which a recorded process may have become, is not left to the reap.
    const scope = daemonScope(new Set(record.pids));
    const table = await ops.listProcesses(DETACHED_SWEEP_BUDGET_MS, scope);
    if (!record.canReapInBackground(table)) return false;
    const resumed = record.resumes.retry(table, ops);
    const survivors = record.survivors(table);
    if (survivors.length === 0) return resumed;
    if (performance.now() < until) {
      await reapRecordedSurvivors(record, ops, DETACHED_SWEEP_BUDGET_MS, table);
    }
    return false;
  } catch {
    return false;
  }
}
