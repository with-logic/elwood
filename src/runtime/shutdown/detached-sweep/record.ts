/**
 * Records a PTY leader's detached descendants while a graceful `stop()` waits for it to
 * exit (PRD §5.3 and §9.4, C-LIFE-10). A CLI that exits on SIGTERM does not end every
 * process it started in a group of its own: Codex leaves the shell it runs to snapshot
 * the user's environment, and whatever the user's profile started from it
 * (docs/cli-behavior.md). Once the leader exits, those processes are reparented to PID 1
 * and nothing links them to the session, so the links are read while it lives: the first
 * read finishes before the SIGTERM is sent, and reads repeat until the leader's exit is
 * observed. A process is recorded by its pid and second-resolution start time
 * (`ProcessEntry.startedAt`). Background retries also refuse an identity first seen
 * within that start second, because a same-second reuse cannot be distinguished.
 * The leader is held to the same observation: a read that does not show the
 * leader the first such read showed records nothing, because its pid may already belong
 * to another process. A leader the read before the SIGTERM does not show had exited
 * before the stop, leaving nothing linked; one that no read showed after a failed first
 * read leaves its tree unknown. A process that starts and loses its link between two
 * reads is not recorded, and a failed read records nothing, so that gap runs to the next
 * read that succeeds (PRD §5.3).
 */

import {
  detachedDescendantGroups,
  processIdentity as identity,
  type ProcessEntry,
} from "../process-table.ts";
import { ResumeDebt } from "./resume-debt.ts";

/** `ps lstart` represents epoch times only to the second. */
export const PROCESS_START_TIME_RESOLUTION_MS = 1_000;

/** The detached descendants seen so far, by pid and start time. */
export class DescendantRecord {
  private readonly identities = new Set<string>();
  private readonly ambiguous = new Set<string>();
  private unknownResume = false;
  /** Groups this record’s reap stopped but could not resume. */
  readonly resumes = new ResumeDebt();
  /** The leader's identity, from the first read that showed it. */
  private leader: string | undefined;
  /**
   * Whether the leader's tree is known: a read showed the leader live, or the read before
   * the SIGTERM showed it already gone, with nothing left linked to it. A later read that
   * does not show the leader says nothing of what it left.
   */
  known = false;

  /**
   * Records every live member of each group, other than the leader's, that holds a
   * descendant, if `table` shows the leader live as the first such read did. `beforeSignal`
   * marks the read before the SIGTERM, whose not showing the leader is knowledge too.
   */
  observe(
    table: readonly ProcessEntry[],
    leaderPid: number,
    beforeSignal = false,
    groups?: ReadonlyMap<number, ReadonlySet<ProcessEntry>>,
    readStartedAtEpochMs = Date.now(),
  ): void {
    const leaderRow = table.find((row) => row.pid === leaderPid && !row.zombie);
    if (leaderRow === undefined) {
      // Gone before the SIGTERM: nothing is linked to it, and its pid is no one's to follow.
      if (beforeSignal) {
        this.known = true;
        this.leader = "";
      }
      return;
    }
    this.leader ??= identity(leaderRow);
    if (identity(leaderRow) !== this.leader) return;
    this.known = true;
    const observedGroups =
      groups ?? detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
    for (const row of table) {
      if (row.zombie || !observedGroups.has(row.pgid)) continue;
      const id = identity(row);
      if (!this.identities.has(id)) {
        const startedEpochMs = Date.parse(`${row.startedAt} UTC`);
        if (
          !Number.isFinite(startedEpochMs) ||
          startedEpochMs + PROCESS_START_TIME_RESOLUTION_MS > readStartedAtEpochMs
        )
          this.ambiguous.add(id);
      }
      this.identities.add(id);
    }
  }

  /** A failed restoration whose stopped members were never read cannot be declared resolved. */
  markUnknownResume(): void {
    this.unknownResume = true;
  }

  /** The first recording read's leader identity, never recaptured from a replacement. */
  get leaderIdentity(): string | undefined {
    return this.leader;
  }

  /** Whether the read before SIGTERM showed the leader already gone. */
  get leaderGone(): boolean {
    return this.leader === "";
  }

  /** Groups with a recorded member whose second-resolution identity remains ambiguous. */
  unsafeBackgroundGroups(table: readonly ProcessEntry[]): ReadonlySet<number> {
    return new Set(
      this.survivors(table)
        .filter((row) => this.ambiguous.has(identity(row)))
        .map((row) => row.pgid),
    );
  }

  /** An unobserved failed restoration is never cleared by an unrelated empty survivor set. */
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
