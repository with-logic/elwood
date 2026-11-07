/**
 * Private descendant-record foundation for graceful shutdown (PRD §5.3 and §9.4,
 * C-LIFE-10); not yet wired into the production lifecycle. Records links while the
 * leader lives, before detached helpers can be reparented on its exit. The first
 * observation freezes leader authority: a missing leader stays gone, and a failed,
 * unparseable, same-second, or wrong-group identity cannot be replaced by a later row.
 * Later reads record only descendants of that original identity. Each recorded pid
 * retains its start time, so a reused pid is never taken for the original process.
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
  refuseLeaderObservation,
} from "./leader-observation.ts";

/** The detached descendants seen so far, by pid and start time. */
export class DescendantRecord {
  private readonly identities = new Set<string>();
  /** The leader's identity, from the first read that showed it. */
  private leader: LeaderObservation | undefined;
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
    readStartedAtEpochMs = Date.now(),
  ): void {
    const leaderRow = table.find((row) => row.pid === leaderPid && !row.zombie);
    if (beforeSignal) this.observeFirst(table, leaderPid, readStartedAtEpochMs);
    if (leaderRow === undefined) return;
    this.leader ??= observeLeader(leaderRow, leaderPid, readStartedAtEpochMs);
    if (this.leader.kind !== "observed" || identity(leaderRow) !== this.leader.identity) return;
    this.known = true;
    const groups = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
    for (const row of table) {
      if (!row.zombie && groups.has(row.pgid)) this.identities.add(identity(row));
    }
  }

  /** Freeze the first read before signaling; no later row can replace its authority. */
  observeFirst(
    table: readonly ProcessEntry[],
    leaderPid: number,
    readStartedAtEpochMs: number,
  ): LeaderObservation {
    const row = table.find((entry) => entry.pid === leaderPid && !entry.zombie);
    this.leader ??= observeLeader(row, leaderPid, readStartedAtEpochMs);
    if (this.leader.kind === "gone") this.known = true;
    return this.leader;
  }

  /** A failed initial read cannot be healed by observing a later owner of the same PID. */
  refuseFirstObservation(error: unknown): LeaderObservation {
    this.leader ??= refuseLeaderObservation(error);
    return this.leader;
  }

  /** The pid of each process recorded, whatever it runs now. */
  get pids(): readonly number[] {
    return [...this.identities].map((id) => Number.parseInt(id, 10));
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
