/**
 * Records a PTY leader's detached descendants while a graceful `stop()` waits for it to
 * exit (PRD §5.3 and §9.4, C-LIFE-10). A CLI that exits on SIGTERM does not end every
 * process it started in a group of its own: Codex leaves the shell it runs to snapshot
 * the user's environment, and whatever the user's profile started from it
 * (docs/cli-behavior.md). Once the leader exits, those processes are reparented to PID 1
 * and nothing links them to the session, so the links are read while it lives: the first
 * read finishes before the SIGTERM is sent, and reads repeat until the leader's exit is
 * observed. A process is recorded by its pid and start time, which together name one
 * process (see `ProcessEntry.startedAt`), so a pid reused after the exit is never taken
 * for it. The leader is held to the same identity: a read that does not show the
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
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import type { SweepOps } from "./rounds.ts";

/**
 * Each read's bound, the one before the SIGTERM included: the walk's own deadline. A read
 * cut short records nothing, and on a loaded host one read, with Codex's daemon path
 * reads, can take over a second (docs/cli-behavior.md), so a one-second bound there
 * recorded nothing at all and left the leader's tree unknown. Only a `ps` that never
 * answers holds the SIGTERM back for the whole bound.
 */
export const RECORD_READ_MS = DETACHED_SWEEP_BUDGET_MS;

/** The detached descendants seen so far, by pid and start time. */
export class DescendantRecord {
  private readonly identities = new Set<string>();
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
  observe(table: readonly ProcessEntry[], leaderPid: number, beforeSignal = false): void {
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
    const groups = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
    for (const row of table) {
      if (!row.zombie && groups.has(row.pgid)) this.identities.add(identity(row));
    }
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

/** A recording in progress. */
export type DescendantWatch = {
  /** Settles once the first read has finished, whether or not it succeeded. */
  readonly firstRead: Promise<void>;
  /** Stops reading once the read in flight settles, and resolves to the record. */
  readonly finish: () => Promise<DescendantRecord>;
};

/**
 * Reads the table again and again, with Codex's daemon marked under `leaderPid`, recording
 * the leader's detached descendants until `finish` is called or `leaderExited` reports the
 * exit. A failed read records nothing and the next one follows.
 */
export function watchDescendants(
  leaderPid: number,
  ops: Pick<SweepOps, "listProcesses">,
  leaderExited: () => boolean,
): DescendantWatch {
  const record = new DescendantRecord();
  let watching = true;
  const scope = daemonScope(new Set([leaderPid]));
  const readOnce = (beforeSignal = false) =>
    ops.listProcesses(RECORD_READ_MS, scope).then(
      (table) => record.observe(table, leaderPid, beforeSignal),
      () => undefined,
    );
  const firstRead = readOnce(true);
  const finishing = Promise.withResolvers<void>();
  const reading = (async () => {
    await firstRead;
    while (!leaderExited()) {
      // Lets the exit be observed between reads; a `finish` ends the wait at once.
      await Promise.race([new Promise((resolve) => setImmediate(resolve)), finishing.promise]);
      if (!watching || leaderExited()) return;
      await readOnce();
    }
  })();
  return {
    firstRead,
    finish: async () => {
      watching = false;
      finishing.resolve();
      await reading;
      return record;
    },
  };
}
