/**
 * Keeps reaping, in the background, the detached descendants a failed walk or survivor
 * reap recorded (PRD §5.3, C-LIFE-14). Once the leader is gone nothing links them to the
 * session, and its pid may belong to another process, so the walk is never tried again
 * from it. Recorded pid/start-time pairs are second-resolution observations, and a
 * failure that left them running would leave them running for good: the host is told the
 * shutdown attempt failed and moves on. So each attempt reads the table, and the reap is resolved
 * once no recorded non-daemon survivor remains and any failed daemon resume is resolved;
 * a pid now held by a process with another start time is none of them. Until then each
 * attempt reaps them by the survivor reap's rules
 * (`survivors.ts`), and the next follows a second later, for a minute at most. Its timers
 * and its reads never keep the host alive. A record with no process in it is never
 * resolved: nothing shows what the failure left running.
 */

import { SerialReapQueue } from "../reap-queue.ts";
import { type DaemonScope, daemonScope } from "../shared-daemon.ts";
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
  /** A later explicit shutdown confirms retained evidence after automatic retries expired. */
  readonly confirm: () => Promise<void> | undefined;
};

/** Serializes a session’s foreground and background signal passes. */
export type ReapQueue = <T>(attempt: () => Promise<T>) => Promise<T>;

/** Retries this record without holding the host alive, within the bounded lifetime. */
export function reapInBackground(
  record: DescendantRecord,
  ops: SweepOps,
  serialize: ReapQueue = standaloneQueue(),
  confirmationOps: SweepOps = ops,
): BackgroundReap {
  if (record.pids.length === 0) return { resolved: () => false, confirm: () => undefined };
  let resolved = false;
  const scope = daemonScope(new Set(record.pids));
  const withKnownPaths = (reads: SweepOps): SweepOps => ({
    ...reads,
    listProcesses: (timeoutMs, innerScope) =>
      reads.listProcesses(timeoutMs, { ...scope, ...innerScope, known: scope.known }),
  });
  const recoveryOps = withKnownPaths(ops);
  const foregroundOps = withKnownPaths(confirmationOps);
  const until = performance.now() + BACKGROUND_REAP_LIFETIME_MS;
  const check = (mayReap: boolean) => async () => {
    if (!resolved)
      resolved = await attempt(
        record,
        mayReap ? recoveryOps : foregroundOps,
        until,
        scope,
        mayReap,
      );
    return resolved;
  };
  void (async () => {
    while (performance.now() < until && !(await serialize(check(true)))) {
      if (performance.now() >= until) return;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_REAP_RETRY_MS).unref());
    }
  })();
  return {
    resolved: () => resolved,
    confirm: () => {
      if (performance.now() < until || resolved) return undefined;
      return serialize(check(false)).then(() => undefined);
    },
  };
}

/**
 * One retry’s first table read also seeds its survivor reap, avoiding a duplicate scan.
 * Each attempt gets a fresh ten-second timeout, equal to the walk’s budget: one read can
 * take over a second on a loaded host; a shorter bound would fail every retry.
 */
async function attempt(
  record: DescendantRecord,
  ops: SweepOps,
  until: number,
  scope: DaemonScope,
  mayReap: boolean,
): Promise<boolean> {
  try {
    // Codex's daemon, which a recorded process may have become, is not left to the reap.
    const table = await ops.listProcesses(DETACHED_SWEEP_BUDGET_MS, scope);
    const resumeDebtResolved = record.resumes.retry(table, ops);
    const survivors = record.survivors(table);
    if (survivors.length === 0)
      return resumeDebtResolved && !record.hasUnknownResume && record.known;
    if (mayReap && performance.now() < until) {
      await reapRecordedSurvivors(record, ops, DETACHED_SWEEP_BUDGET_MS, table, true);
    }
    return false;
  } catch {
    return false;
  }
}

/** A standalone record still serializes automatic attempts and explicit confirmations. */
function standaloneQueue(): ReapQueue {
  const queue = new SerialReapQueue();
  return (attempt) => queue.run(attempt);
}
