/**
 * Private descendant-record foundation for graceful shutdown (PRD §5.3 and §9.4,
 * C-LIFE-10); not yet wired into the production lifecycle. Records links while the
 * leader lives, before detached helpers can be reparented on its exit. The first
 * observation freezes leader authority: a missing leader stays gone, and a failed,
 * unparseable, same-second, or wrong-group identity cannot be replaced by a later row.
 * Later reads record only descendants of that original identity. Each recorded pid
 * retains its second-resolution start time, so distinguishable PID reuse is rejected.
 * A failed later read records nothing and preserves the baseline for the next read.
 */

import {
  detachedDescendantGroups,
  processIdentity as identity,
  type ProcessEntry,
} from "../process-table.ts";
import {
  type LeaderObservation,
  observeLeader,
  PROCESS_START_TIME_RESOLUTION_MS,
  refuseLeaderObservation,
} from "./leader-observation.ts";
import { ResumeDebt } from "./resume-debt.ts";

/** The detached descendants seen so far, by pid and start time. */
export class DescendantRecord {
  private readonly identities = new Set<string>();
  private readonly ambiguous = new Set<string>();
  private unknownResume = false;
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

  /** Retain first-observation ambiguity for owned group members across later reads. */
  observeGroups(
    table: readonly ProcessEntry[],
    groups: ReadonlyMap<number, ReadonlySet<ProcessEntry>>,
    readStartedAtEpochMs: number,
  ): void {
    for (const row of table) {
      if (row.zombie || !groups.has(row.pgid)) continue;
      const id = identity(row);
      if (!this.identities.has(id)) {
        const started = Date.parse(`${row.startedAt} UTC`);
        if (
          !Number.isFinite(started) ||
          started + PROCESS_START_TIME_RESOLUTION_MS > readStartedAtEpochMs
        )
          this.ambiguous.add(id);
      }
      this.identities.add(id);
    }
  }

  /** Only a matching live ambiguous identity blocks its group. */
  unsafeSurvivorGroups(table: readonly ProcessEntry[]): ReadonlySet<number> {
    return new Set(
      this.survivors(table)
        .filter((row) => this.ambiguous.has(identity(row)))
        .map((row) => row.pgid),
    );
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

  /**
   * The rows of `table` that are recorded processes still alive: same pid, same start.
   * Never Codex's shared daemon, which one may have become by `exec` since it was recorded.
   */
  survivors(table: readonly ProcessEntry[]): readonly ProcessEntry[] {
    const recorded = (row: ProcessEntry) => this.identities.has(identity(row));
    return table.filter((row) => !row.zombie && recorded(row) && !row.shared);
  }
}
