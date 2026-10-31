/**
 * Verifies a stopped leader before graceful SIGTERM (PRD §5.3, C-LIFE-10). Holding it
 * prevents voluntary exit/reuse across verification and signal; POSIX snapshots are
 * not an atomic generation handle against an external force-kill or resume.
 */
import { errnoCode, toError } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

type HeldLeaderSignal = {
  readonly pid: number;
  readonly record: DescendantRecord;
  readonly identity: string | undefined;
  readonly ops: SweepOps;
  readonly leaderExited: () => boolean;
  readonly deadline: number;
  readonly send: () => void;
};

/** Returns true when the leader is gone; otherwise sends only while its identity is held. */
export async function sendHeldLeaderSignal({
  pid,
  record,
  identity,
  ops,
  leaderExited,
  deadline,
  send,
}: HeldLeaderSignal): Promise<boolean> {
  if (leaderExited() || record.leaderGone) return true;
  if (identity === undefined) throw new Error("No recorded leader identity before SIGTERM.");
  remaining(deadline);
  try {
    ops.stopGroup(pid);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return true;
    throw error;
  }
  const read: HeldRead = { table: undefined };
  let gone = false;
  const failures: unknown[] = [];
  try {
    gone = await verifyAndSend(
      { pid, record, identity, ops, leaderExited, deadline, send },
      identity,
      read,
    );
  } catch (error) {
    failures.push(error);
  }
  restoreLeader(pid, record, ops, read.table, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const code = errnoCode(failures[0]);
    const message = failures.map((error) => toError(error).message).join("; ");
    throw Object.assign(new AggregateError(failures, message), code === undefined ? {} : { code });
  }
  return gone;
}

type HeldRead = { table: readonly ProcessEntry[] | undefined };

/** Keeps the post-stop read even if its verification or queued signal fails. */
async function verifyAndSend(
  signal: HeldLeaderSignal,
  identity: string,
  read: HeldRead,
): Promise<boolean> {
  const { pid, ops, leaderExited, deadline, send } = signal;
  if (leaderExited()) return true;
  const table = await ops.listProcesses(remaining(deadline));
  read.table = table;
  const leader = table.find((row) => row.pid === pid && !row.zombie);
  if (leaderExited() || leader === undefined) return true;
  if (processIdentity(leader) !== identity || leader.pgid !== pid || !leader.stopped)
    throw new Error("The recorded leader was not confirmed stopped before SIGTERM.");
  remaining(deadline);
  send();
  return false;
}

/** Restore every successful SIGSTOP; preserve both a primary failure and a failed resume. */
function restoreLeader(
  pid: number,
  record: DescendantRecord,
  ops: SweepOps,
  table: readonly ProcessEntry[] | undefined,
  failures: unknown[],
): void {
  try {
    ops.continueGroup(pid);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return;
    if (table?.some((row) => !row.zombie && row.pgid === pid)) record.resumes.remember(table, pid);
    else record.markUnknownResume();
    failures.push(error);
  }
}

function remaining(deadline: number): number {
  const left = Math.ceil(deadline - performance.now());
  if (left <= 0)
    throw Object.assign(new Error("Leader verification deadline expired before SIGTERM."), {
      code: "ETIMEDOUT",
    });
  return left;
}
