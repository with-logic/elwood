/**
 * Verifies a stopped leader before graceful SIGTERM (PRD §5.3, C-LIFE-10). Holding it
 * prevents voluntary exit/reuse; POSIX snapshots cannot fence external kill/resume.
 */
import { errnoCode, toError } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

export type LeaderSignalOutcome = "leader-gone" | "signal-sent";
type HeldLeaderSignal = {
  readonly pid: number;
  readonly record: DescendantRecord;
  readonly identity: string | undefined;
  readonly firstReadFailure: Error | undefined;
  readonly ops: SweepOps;
  readonly leaderExited: () => boolean;
  readonly deadline: number;
  readonly send: () => void;
  readonly forbidLeaderSignals: (error: unknown) => void;
};

/** Sends only while the original leader is held; uncertain authorization forbids later signals. */
export async function sendHeldLeaderSignal(signal: HeldLeaderSignal): Promise<LeaderSignalOutcome> {
  const { pid, record, identity, ops, leaderExited, forbidLeaderSignals } = signal;
  if (leaderExited() || record.leaderGone) return "leader-gone";
  let stopped = false;
  let authorized = false;
  const read: HeldRead = { table: undefined };
  const failures: unknown[] = [];
  let outcome: LeaderSignalOutcome = "leader-gone";
  try {
    if (identity === undefined)
      throw signal.firstReadFailure ?? new Error("No recorded leader identity before SIGTERM.");
    stopped = await stopLeader(signal);
    if (!stopped) return "leader-gone";
    if ((await verifyHeldLeader(signal, identity, read)) === "leader-held") {
      authorized = true;
      signal.send();
      outcome = "signal-sent";
    }
  } catch (error) {
    if (!authorized) forbidLeaderSignals(error);
    failures.push(error);
  }
  // Restore only the hold already sent, even when it exposed a replacement; never TERM/KILL it.
  if (stopped) restoreLeader(pid, record, ops, read.table, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const code = errnoCode(failures[0]);
    const message = failures.map((error) => toError(error).message).join("; ");
    throw Object.assign(new AggregateError(failures, message), code === undefined ? {} : { code });
  }
  return outcome;
}

type HeldRead = { table: readonly ProcessEntry[] | undefined };

/** EPERM can mean a zombie-only group on macOS; only a bounded fresh read proves that. */
async function stopLeader(signal: HeldLeaderSignal): Promise<boolean> {
  const { pid, ops, leaderExited, deadline } = signal;
  remaining(deadline);
  try {
    ops.stopGroup(pid);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    if (errnoCode(error) !== "EPERM") throw error;
    if (leaderExited()) return false;
    const table = await readLeaderTable(signal);
    const liveLeader = table.some((row) => row.pid === pid && !row.zombie);
    if (leaderExited() || !liveLeader) return false;
    throw error;
  }
}

/** Distinct identity, group and stopped-state predicates authorize only the original held leader. */
async function verifyHeldLeader(
  signal: HeldLeaderSignal,
  identity: string,
  read: HeldRead,
): Promise<"leader-held" | "leader-gone"> {
  const { pid, leaderExited, deadline } = signal;
  if (leaderExited()) return "leader-gone";
  const table = await readLeaderTable(signal);
  read.table = table;
  const leader = table.find((row) => row.pid === pid && !row.zombie);
  if (leaderExited() || leader === undefined) return "leader-gone";
  const originalIdentity = processIdentity(leader) === identity;
  const originalGroup = leader.pgid === pid;
  const confirmedStopped = leader.stopped;
  if (!(originalIdentity && originalGroup && confirmedStopped))
    throw new Error("The recorded leader was not confirmed stopped before SIGTERM.");
  remaining(deadline);
  return "leader-held";
}

/** An observed PTY exit also confirms a read failure no longer needs a leader signal. */
async function readLeaderTable(signal: HeldLeaderSignal): Promise<readonly ProcessEntry[]> {
  try {
    return await signal.ops.listProcesses(remaining(signal.deadline));
  } catch (error) {
    if (signal.leaderExited()) return [];
    throw error;
  }
}

/** Preserve both the primary failure and any failed restoration's identity-bound debt. */
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
