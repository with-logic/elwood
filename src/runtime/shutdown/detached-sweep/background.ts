/** Private bounded recovery of retained shutdown observations (PRD §9.4, C-LIFE-10). */
import type { ReapQueue } from "../reap-queue.ts";
import { type DaemonScope, daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";
import { reapRecordedSurvivors } from "./survivors.ts";

/** Automatic retries end, while their identity-bound evidence remains available. */
export const BACKGROUND_REAP_RETRY_WINDOW_MS = 60_000;
export const BACKGROUND_REAP_RETRY_MS = 1_000;
type AttemptOutcome = "resolved" | "retry" | "blocked";
export type BackgroundReap = { readonly resolved: () => boolean };

/** Never restart ancestry traversal from the dead leader's numeric PID. */
export function reapInBackground(
  record: DescendantRecord,
  ops: SweepOps,
  serialize: ReapQueue,
): BackgroundReap {
  let resolved = false;
  const recovery = { resolved: () => resolved };
  if (record.pids.length === 0) return recovery;
  const roots = new Set(record.pids);
  const scope = daemonScope(roots);
  const recoveryOps = withKnownPaths(ops, scope);
  const until = performance.now() + BACKGROUND_REAP_RETRY_WINDOW_MS;
  void (async () => {
    while (performance.now() < until) {
      for (const pid of record.pids) roots.add(pid);
      const outcome = await serialize(() => attempt(record, recoveryOps, scope, until));
      resolved = outcome === "resolved";
      if (outcome !== "retry" || performance.now() >= until) return;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_REAP_RETRY_MS).unref());
    }
  })();
  return recovery;
}

/** Keep confirmed daemon paths for this recovery, including nested survivor reads. */
function withKnownPaths(ops: SweepOps, scope: DaemonScope): SweepOps {
  return {
    ...ops,
    listProcesses: (timeoutMs, innerScope) =>
      ops.listProcesses(timeoutMs, { ...scope, ...innerScope, known: scope.known }),
  };
}

/** One fresh read seeds the safe survivor reap; success still needs a later empty read. */
async function attempt(
  record: DescendantRecord,
  ops: SweepOps,
  scope: DaemonScope,
  until: number,
): Promise<AttemptOutcome> {
  if (performance.now() >= until) return "blocked";
  try {
    const readStartedAtEpochMs = Date.now();
    const table = await ops.listProcesses(DETACHED_SWEEP_BUDGET_MS, scope);
    const resumed = record.resumes.retry(table, ops);
    const survivors = record.survivors(table);
    if (survivors.length === 0) {
      if (record.known && resumed && !record.hasUnknownResume) return "resolved";
      return resumed ? "blocked" : "retry";
    }
    if (!record.known) return resumed ? "blocked" : "retry";
    if (performance.now() < until)
      await reapRecordedSurvivors(record, ops, DETACHED_SWEEP_BUDGET_MS, {
        table,
        readStartedAtEpochMs,
      });
    return "retry";
  } catch {
    return "retry";
  }
}
