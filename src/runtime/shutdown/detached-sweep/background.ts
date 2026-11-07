/** Private bounded recovery of retained shutdown observations (PRD §9.4, C-LIFE-10). */
import type { ReapQueue } from "../reap-queue.ts";
import { type DaemonScope, daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";

/** Sixty seconds allows delayed cleanup without scanning the host indefinitely. */
export const BACKGROUND_REAP_RETRY_WINDOW_MS = 60_000;
/** One-second gaps limit repeated full-table scans while still observing delayed exit. */
export const BACKGROUND_REAP_RETRY_MS = 1_000;
type AttemptOutcome = "resolved" | "retry" | "blocked";
export type BackgroundReap = {
  /**
   * True once known evidence resolves. False includes active retries and stopped,
   * unresolved recovery; it does not report loop completion.
   */
  readonly resolved: () => boolean;
  readonly confirm: () => Promise<void> | undefined;
};

/** Never restart ancestry traversal from the dead leader's numeric PID. */
export function reapInBackground(
  record: DescendantRecord,
  ops: SweepOps,
  serialize: ReapQueue,
  confirmationOps: SweepOps = ops,
): BackgroundReap {
  let resolved = false;
  if (record.pids.length === 0) return { resolved: () => resolved, confirm: () => undefined };
  const roots = new Set(record.pids);
  const scope = daemonScope(roots);
  const recoveryOps = withKnownPaths(ops, scope, record);
  const foregroundOps = withKnownPaths(confirmationOps, scope, record);
  const until = performance.now() + BACKGROUND_REAP_RETRY_WINDOW_MS;
  const recovery: BackgroundReap = {
    resolved: () => resolved,
    confirm: () => {
      if (resolved || performance.now() < until) return undefined;
      const deadline = performance.now() + DETACHED_SWEEP_BUDGET_MS;
      let timer: NodeJS.Timeout;
      // This reference owns the foreground request even while an unreferenced pass holds the queue.
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DETACHED_SWEEP_BUDGET_MS);
      });
      const checking = serialize(async () => {
        if (resolved || performance.now() >= deadline) return;
        for (const pid of record.pids) roots.add(pid);
        resolved = (await attempt(record, foregroundOps, scope, deadline, false)) === "resolved";
      });
      return Promise.race([checking, expired]).finally(() => clearTimeout(timer));
    },
  };
  void (async () => {
    while (performance.now() < until) {
      for (const pid of record.pids) roots.add(pid);
      const outcome = await serialize(() => attempt(record, recoveryOps, scope, until, true));
      resolved = outcome === "resolved";
      if (outcome !== "retry" || performance.now() >= until) return;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_REAP_RETRY_MS).unref());
    }
  })();
  return recovery;
}

/** Retain paths and unreadable gaps for every recovery read, including nested survivor reads. */
function withKnownPaths(ops: SweepOps, scope: DaemonScope, record: DescendantRecord): SweepOps {
  return {
    ...ops,
    listProcesses: async (timeoutMs, innerScope) => {
      try {
        return await ops.listProcesses(timeoutMs, { ...scope, ...innerScope, known: scope.known });
      } catch (error) {
        record.noteReadFailure(error);
        throw error;
      }
    },
  };
}

/** One fresh read seeds the safe survivor reap; success still needs a later empty read. */
async function attempt(
  record: DescendantRecord,
  ops: SweepOps,
  scope: DaemonScope,
  until: number,
  mayReap: boolean,
): Promise<AttemptOutcome> {
  if (performance.now() >= until) return "blocked";
  try {
    const readStartedAtEpochMs = Date.now();
    const budget = mayReap ? DETACHED_SWEEP_BUDGET_MS : Math.ceil(until - performance.now());
    const table = await ops.listProcesses(budget, scope);
    if (!mayReap && performance.now() >= until) return "blocked";
    const resumeDebtCleared = record.resumes.retry(table, ops);
    const survivors = record.survivors(table);
    if (survivors.length === 0) {
      const knownEvidenceResolved =
        record.known &&
        resumeDebtCleared &&
        !record.hasUnknownResume &&
        !record.hasObservationUncertainty;
      if (knownEvidenceResolved) return "resolved";
      return resumeDebtCleared ? "blocked" : "retry";
    }
    if (!record.known) return resumeDebtCleared ? "blocked" : "retry";
    if (mayReap && performance.now() < until)
      await reapRecordedSurvivors(record, ops, DETACHED_SWEEP_BUDGET_MS, {
        table,
        readStartedAtEpochMs,
      });
    return "retry";
  } catch {
    return "retry";
  }
}
