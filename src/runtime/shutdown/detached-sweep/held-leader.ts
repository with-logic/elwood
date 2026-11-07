/** Private held-leader signal foundation; no lifecycle caller yet (PRD §5.3/§9.4, C-LIFE-10). */
import { scheduler } from "node:timers/promises";
import { errnoCode } from "../../../core/errors.ts";
import { aggregateSignalFailures, throwSignalFailures } from "../merge-sweep-errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { ReapQueue } from "../reap-queue.ts";
import { confirmRestoration, remainingMs } from "./hold-restoration.ts";
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
  readonly observation: LeaderObservation | Promise<LeaderObservation>;
  readonly ops: SweepOps;
  readonly leaderExited: () => boolean;
  readonly deadline: number;
  readonly guard: LeaderSignalGuard;
  readonly send: () => void;
};

/** No signal after lost authority; only restore a hold this pass already sent. */
export function sendHeldLeaderSignal(signal: HeldLeader): Promise<LeaderSignalOutcome> {
  return signal.guard.serialize(() => sendSerializedLeaderSignal(signal));
}

async function sendSerializedLeaderSignal(signal: HeldLeader): Promise<LeaderSignalOutcome> {
  const { guard } = signal;
  let stoppedIdentity: string | undefined;
  let authorized = false;
  let groupGone = false;
  const read: HeldRead = { table: undefined };
  const failures: unknown[] = [];
  try {
    const observation = await signal.observation;
    guard.assertRetainedAuthority();
    assertLeaderObservation(observation);
    if (observation.kind === "gone" || signal.leaderExited())
      throw new Error("The original leader exited before graceful signal authorization.");
    if (!observation.identity.startsWith(`${signal.pid} `))
      throw new Error("The original leader identity does not match the signal target.");
    const stopSent = await stopLeaderGroup(signal);
    if (stopSent) stoppedIdentity = observation.identity;
    groupGone =
      !stopSent ||
      (await verifyHeldLeader(signal, observation.identity, read)) === "leader-group-gone";
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
  if (stoppedIdentity !== undefined && !groupGone)
    groupGone = await restoreHold(signal, stoppedIdentity, read.table, failures);
  throwSignalFailures(failures);
  return groupGone ? "leader-group-gone" : "signal-sent";
}

type HeldRead = { table: readonly ProcessEntry[] | undefined };

/** ESRCH or a bounded fresh empty-group read is terminal whole-group evidence. */
async function stopLeaderGroup(signal: HeldLeader): Promise<boolean> {
  const { pid, ops, deadline } = signal;
  remainingMs(deadline);
  try {
    ops.stopGroup(pid);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    if (errnoCode(error) !== "EPERM") throw error;
    let table: readonly ProcessEntry[];
    try {
      table = await ops.listProcesses(remainingMs(deadline));
    } catch (readError) {
      throw aggregateSignalFailures([error, readError]);
    }
    if (!table.some((row) => row.pgid === pid && !row.zombie)) return false;
    throw error;
  }
}

/** Distinct identity, group and stopped predicates authorize only the original held leader. */
async function verifyHeldLeader(
  signal: HeldLeader,
  identity: string,
  read: HeldRead,
): Promise<"leader-held" | "leader-group-gone"> {
  const { pid, ops, deadline } = signal;
  while (true) {
    const readStartedAtEpochMs = Date.now();
    const table = await ops.listProcesses(remainingMs(deadline));
    read.table = table;
    if (!table.some((row) => row.pgid === pid && !row.zombie)) return "leader-group-gone";
    const leader = table.find((row) => row.pid === pid && !row.zombie);
    const originalIdentity = leader !== undefined && processIdentity(leader) === identity;
    const originalGroup = leader?.pgid === pid;
    if (!(originalIdentity && originalGroup) || signal.leaderExited())
      throw new Error("The original leader was not confirmed held before SIGTERM.");
    remainingMs(deadline);
    if (leader.stopped) {
      signal.record.observeLeaderGroup(table, pid, readStartedAtEpochMs);
      signal.record.observe(table, pid, readStartedAtEpochMs);
      return "leader-held";
    }
    await scheduler.yield();
  }
}

/** The group may exit on TERM and its PGID be reused; CONT requires a fresh original stopped member. */
async function restoreHold(
  signal: HeldLeader,
  identity: string,
  table: readonly ProcessEntry[] | undefined,
  failures: unknown[],
): Promise<boolean> {
  const { pid, ops, record } = signal;
  if (table === undefined) {
    record.markUnknownResume();
    record.resumes.rememberIdentity({ identity, pid, pgid: pid });
    return false;
  }
  const identities = new Set([
    identity,
    ...record
      .restorableMembers(table)
      .filter((row) => row.pgid === pid)
      .map(processIdentity),
  ]);
  const owned = table.filter(
    (row) => !row.zombie && row.pgid === pid && identities.has(processIdentity(row)),
  );
  if (!owned.some((row) => row.stopped)) {
    record.markUnknownResume();
    record.resumes.rememberIdentity({ identity, pid, pgid: pid });
    return false;
  }
  let fresh: readonly ProcessEntry[];
  try {
    fresh = await ops.listProcesses(remainingMs(signal.deadline));
    remainingMs(signal.deadline);
  } catch (error) {
    record.markUnknownResume();
    record.resumes.remember(owned, pid);
    failures.push(error);
    return false;
  }
  if (!fresh.some((row) => !row.zombie && row.pgid === pid)) {
    signal.guard.gone();
    return true;
  }
  const originalMembers = fresh.filter(
    (row) => !row.zombie && row.pgid === pid && identities.has(processIdentity(row)),
  );
  if (!originalMembers.some((row) => row.stopped)) return false;
  try {
    ops.continueGroup(pid);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") {
      signal.guard.gone();
      return true;
    }
    let confirmationError: unknown;
    if (errnoCode(error) === "EPERM") {
      try {
        const confirmed = await confirmRestoration(signal, identities);
        if (confirmed !== "unconfirmed") return confirmed === "group-gone";
      } catch (readError) {
        confirmationError = readError;
      }
    }
    record.resumes.remember(originalMembers, pid);
    failures.push(error);
    if (confirmationError !== undefined) failures.push(confirmationError);
  }
  return false;
}

/** Preserve a failed first read even if native exit arrived before its result. */
export function assertLeaderObservation(
  observation: LeaderObservation,
): asserts observation is Exclude<LeaderObservation, { readonly kind: "refused" }> {
  if (observation.kind === "refused") throw observation.error;
}
