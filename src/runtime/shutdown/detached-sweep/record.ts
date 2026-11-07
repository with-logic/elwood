/**
 * Records original leader-group members and detached helpers for graceful shutdown
 * (PRD §5.3/§9.4, C-LIFE-10).
 * The first observation freezes the leader identity; later reads cannot adopt another.
 * Linked helpers are recorded while that leader lives, before exit can reparent them.
 * Start times reject distinguishable PID reuse. Failed reads and unattributable live
 * leader-group members retain uncertainty through subsequent cleanup attempts.
 */

import {
  detachedDescendantGroups,
  processIdentity as identity,
  type ProcessEntry,
} from "../process-table.ts";
import { SweepFailures } from "./failures.ts";
import {
  type LeaderObservation,
  observeLeader,
  processStartTimeUncertaintyMs,
  refuseLeaderObservation,
} from "./leader-observation.ts";
import { ResumeDebt } from "./resume-debt.ts";

/** Recorded graceful-shutdown processes, by pid and start time. */
export class DescendantRecord {
  private readonly identities = new Set<string>();
  private readonly ambiguous = new Set<string>();
  private leaderGroup: number | undefined;
  private unknownLeaderGroup: number | undefined;
  private unknownResume = false;
  private readonly readFailures = new SweepFailures();
  private missedRead = false;
  readonly resumes = new ResumeDebt();
  /** Frozen first-read result: an accepted identity, confirmed absence, or refusal. */
  private firstLeaderObservation: LeaderObservation | undefined;
  /**
   * Whether a read matched the validated original leader identity, or the first read
   * confirmed it already gone, with nothing left linked to it. Later absence does not
   * establish the tree; an ambiguous or refused first identity never does.
   */
  known = false;

  /** Record detached group members only while the frozen original leader is still live. */
  observe(
    table: readonly ProcessEntry[],
    leaderPid: number,
    readStartedAtEpochMs = Date.now(),
    groups?: ReadonlyMap<number, ReadonlySet<ProcessEntry>>,
  ): void {
    const leaderRow = table.find((row) => row.pid === leaderPid && !row.zombie);
    const first = this.firstLeaderObservation;
    if (
      leaderRow === undefined ||
      first?.kind !== "observed" ||
      identity(leaderRow) !== first.identity
    )
      return;
    this.known = true;
    const observed = groups ?? detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
    this.observeGroups(table, observed, readStartedAtEpochMs);
  }

  /** Graceful cleanup also owns members of the frozen original leader's group. */
  observeLeaderGroup(
    table: readonly ProcessEntry[],
    leaderPid: number,
    readStartedAtEpochMs: number,
  ): void {
    const first = this.firstLeaderObservation;
    const leader = table.find((row) => row.pid === leaderPid && !row.zombie);
    if (
      first?.kind !== "observed" ||
      leader?.pgid !== leaderPid ||
      identity(leader) !== first.identity
    )
      return;
    this.known = true;
    this.leaderGroup = leaderPid;
    this.observeGroups(
      table,
      new Map([[leaderPid, new Set<ProcessEntry>()]]),
      readStartedAtEpochMs,
    );
  }

  /** Retain first-observation ambiguity for owned group members across later reads. */
  observeGroups(
    table: readonly ProcessEntry[],
    groups: ReadonlyMap<number, ReadonlySet<ProcessEntry>>,
    readStartedAtEpochMs: number,
  ): void {
    const startTimeUncertaintyMs = processStartTimeUncertaintyMs();
    for (const row of table) {
      if (row.zombie || !groups.has(row.pgid)) continue;
      const id = identity(row);
      if (!this.identities.has(id)) {
        const started = Date.parse(`${row.startedAt} UTC`);
        if (!Number.isFinite(started) || started + startTimeUncertaintyMs > readStartedAtEpochMs)
          this.ambiguous.add(id);
      }
      this.identities.add(id);
    }
  }

  /** Ambiguous identities and unattributable original-group members cannot authorize cleanup. */
  unsafeSurvivorGroups(table: readonly ProcessEntry[]): ReadonlySet<number> {
    if (this.leaderGroup !== undefined) {
      const members = table.filter((row) => !row.zombie && row.pgid === this.leaderGroup);
      if (members.length > 0 && !members.some((row) => this.identities.has(identity(row))))
        this.unknownLeaderGroup = this.leaderGroup;
    }
    const unsafe = new Set(
      this.survivors(table)
        .filter((row) => this.ambiguous.has(identity(row)))
        .map((row) => row.pgid),
    );
    if (this.unknownLeaderGroup !== undefined) unsafe.add(this.unknownLeaderGroup);
    return unsafe;
  }

  /** Freeze the first read before signaling; no later row can replace its authority. */
  observeFirst(
    table: readonly ProcessEntry[],
    leaderPid: number,
    readStartedAtEpochMs: number,
  ): LeaderObservation {
    const row = table.find((entry) => entry.pid === leaderPid && !entry.zombie);
    this.firstLeaderObservation ??= observeLeader(row, leaderPid, readStartedAtEpochMs);
    if (this.firstLeaderObservation.kind === "gone") this.known = true;
    return this.firstLeaderObservation;
  }

  /** A failed initial read cannot be healed by observing a later owner of the same PID. */
  refuseFirstObservation(error: unknown): LeaderObservation {
    this.firstLeaderObservation ??= refuseLeaderObservation(error);
    return this.firstLeaderObservation;
  }

  /** A failed observation can hide an orphan; later readable tables cannot disprove it. */
  noteReadFailure(error: unknown): void {
    if (this.missedRead) return;
    this.missedRead = true;
    this.readFailures.record("process table unreadable", error, []);
  }

  /** Carry bounded observation uncertainty through every later cleanup attempt. */
  includeReadFailure(failures: SweepFailures): void {
    const failure = this.readFailures.result();
    if (failure !== undefined) failures.record("process table unreadable", failure, []);
  }

  /** A failed restoration without a fresh process identity cannot be retried safely. */
  markUnknownResume(): void {
    this.unknownResume = true;
  }

  get hasUnknownResume(): boolean {
    return this.unknownResume;
  }

  /** The pid of each process recorded, whatever it runs now. */
  get pids(): readonly number[] {
    return [
      ...new Set(
        [...this.identities].map((id) => Number.parseInt(id, 10)).concat(this.resumes.pids),
      ),
    ];
  }

  /** Original unambiguous members, including shared processes whose holds need restoration. */
  restorableMembers(table: readonly ProcessEntry[]): readonly ProcessEntry[] {
    return table.filter(
      (row) =>
        !row.zombie && this.identities.has(identity(row)) && !this.ambiguous.has(identity(row)),
    );
  }

  /**
   * The rows of `table` that are recorded processes still alive: same pid, same start.
   * Never Codex's shared daemon, which one may have become by `exec` since it was recorded.
   */
  survivors(table: readonly ProcessEntry[]): readonly ProcessEntry[] {
    const recorded = (row: ProcessEntry) => this.identities.has(identity(row));
    return table.filter((row) => !row.zombie && recorded(row) && !row.shared);
  }
}
