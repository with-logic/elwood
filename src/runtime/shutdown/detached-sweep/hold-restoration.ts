/** Confirms refused graceful restoration within its original deadline (PRD §5.3/§9.4, C-LIFE-10). */
import { processIdentity } from "../process-table.ts";
import { processReadTimeout } from "../read-timeout.ts";
import type { SweepOps } from "./rounds.ts";

type HoldRestoration = {
  readonly pid: number;
  readonly ops: SweepOps;
  readonly deadline: number;
  readonly guard: { readonly gone: () => void };
};

/** Darwin CONT/EPERM can mean the original group resumed or exited during TERM. */
export async function confirmRestoration(
  signal: HoldRestoration,
  identities: ReadonlySet<string>,
): Promise<boolean | undefined> {
  const fresh = await signal.ops.listProcesses(remainingMs(signal.deadline));
  remainingMs(signal.deadline);
  if (!fresh.some((row) => row.pgid === signal.pid && !row.zombie)) {
    signal.guard.gone();
    return true;
  }
  const originalMemberIsRunning = fresh.some(
    (row) =>
      !(row.zombie || row.stopped) &&
      row.pgid === signal.pid &&
      identities.has(processIdentity(row)),
  );
  const hasStoppedLiveGroupMember = fresh.some(
    (row) => !row.zombie && row.stopped && row.pgid === signal.pid,
  );
  return originalMemberIsRunning && !hasStoppedLiveGroupMember ? false : undefined;
}

/** Share the original graceful deadline through all verification and restoration reads. */
export function remainingMs(deadline: number): number {
  const left = Math.ceil(deadline - performance.now());
  if (left <= 0) throw processReadTimeout("Graceful leader verification deadline expired.");
  return left;
}
