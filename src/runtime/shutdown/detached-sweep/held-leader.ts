/** Private held-leader signal foundation; no lifecycle caller yet (PRD §5.3/§9.4, C-LIFE-10). */
import { errnoCode, toError } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { ReapQueue } from "../reap-queue.ts";
import type { LeaderObservation } from "./leader-observation.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps } from "./rounds.ts";

/** Shared signal authority and serialization for every pass owned by one session. */
export type LeaderSignalGuard = {
  readonly serialize: ReapQueue;
  readonly assertRetainedAuthority: () => void;
  readonly authorize: () => void;
  readonly forbid: (error: unknown) => void;
  readonly gone: () => void;
};
export type LeaderSignalOutcome = "signal-sent" | "leader-group-gone";
type HeldLeader = {
  readonly pid: number;
  readonly record: DescendantRecord;
  readonly observation: LeaderObservation;
  readonly ops: SweepOps;
  readonly leaderExited: () => boolean;
  readonly deadline: number;
  readonly guard: LeaderSignalGuard;
  readonly send: () => void;
};

/** No signal after lost authority; only restore a hold this pass already sent. */
export async function sendHeldLeaderSignal(signal: HeldLeader): Promise<LeaderSignalOutcome> {
  const { guard, observation } = signal;
  let stopSent = false;
  let authorized = false;
  let groupGone = false;
  const read: HeldRead = { table: undefined };
  const failures: unknown[] = [];
  try {
    guard.assertRetainedAuthority();
    assertLeaderObservation(observation);
    if (observation.kind === "gone" || signal.leaderExited())
      throw new Error("The original leader exited before graceful signal authorization.");
    stopSent = await stopLeader(signal);
    groupGone = !stopSent || (await verifyHeldLeader(signal, observation.identity, read));
    if (groupGone) guard.gone();
    else {
      guard.authorize();
      authorized = true;
      signal.send();
    }
  } catch (error) {
    if (!authorized) guard.forbid(error);
    failures.push(error);
  }
  if (stopSent && !groupGone) groupGone = restoreHold(signal, read.table, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const code = errnoCode(failures[0]);
    throw Object.assign(
      new AggregateError(failures, failures.map((error) => toError(error).message).join("; ")),
      code === undefined ? {} : { code },
    );
  }
  return groupGone ? "leader-group-gone" : "signal-sent";
}

type HeldRead = { table: readonly ProcessEntry[] | undefined };

/** ESRCH or a bounded fresh empty-group read is terminal whole-group evidence. */
async function stopLeader(signal: HeldLeader): Promise<boolean> {
  const { pid, ops, deadline } = signal;
  remaining(deadline);
  try {
    ops.stopGroup(pid);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    if (errnoCode(error) !== "EPERM") throw error;
    const table = await ops.listProcesses(remaining(deadline));
    if (!table.some((row) => row.pgid === pid && !row.zombie)) return false;
    throw error;
  }
}

/** Distinct identity, group and stopped predicates authorize only the original held leader. */
async function verifyHeldLeader(
  signal: HeldLeader,
  identity: string,
  read: HeldRead,
): Promise<boolean> {
  const { pid, ops, deadline } = signal;
  const table = await ops.listProcesses(remaining(deadline));
  read.table = table;
  if (!table.some((row) => row.pgid === pid && !row.zombie)) return true;
  const leader = table.find((row) => row.pid === pid && !row.zombie);
  const originalIdentity = leader !== undefined && processIdentity(leader) === identity;
  const originalGroup = leader?.pgid === pid;
  const confirmedStopped = leader?.stopped === true;
  if (!(originalIdentity && originalGroup && confirmedStopped) || signal.leaderExited())
    throw new Error("The original leader was not confirmed held before SIGTERM.");
  remaining(deadline);
  return false;
}

/** Retain known stopped identities, or unknown restoration if no post-stop table was readable. */
function restoreHold(
  signal: HeldLeader,
  table: readonly ProcessEntry[] | undefined,
  failures: unknown[],
): boolean {
  const { pid, ops, record } = signal;
  try {
    ops.continueGroup(pid);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") {
      signal.guard.gone();
      return true;
    }
    if (table?.some((row) => row.pgid === pid && !row.zombie)) record.resumes.remember(table, pid);
    else record.markUnknownResume();
    failures.push(error);
  }
  return false;
}

function remaining(deadline: number): number {
  const left = Math.ceil(deadline - performance.now());
  if (left <= 0)
    throw Object.assign(new Error("Graceful leader verification deadline expired."), {
      code: "ETIMEDOUT",
    });
  return left;
}

/** Preserve a failed first read even if native exit arrived before its result. */
export function assertLeaderObservation(
  observation: LeaderObservation,
): asserts observation is Exclude<LeaderObservation, { readonly kind: "refused" }> {
  if (observation.kind === "refused") throw observation.error;
}
