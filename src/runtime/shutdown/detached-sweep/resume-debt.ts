/** Keeps a failed stopped-group SIGCONT pending across background retries (C-LIFE-14). */
import { errnoCode } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { SweepOps } from "./rounds.ts";

/** Identity-bound rows from groups that Elwood stopped but could not resume. */
export class ResumeDebt {
  private readonly rows = new Map<string, ProcessEntry>();

  /** Records live identities of a group Elwood stopped but could not resume. */
  remember(table: readonly ProcessEntry[], group: number): void {
    for (const row of table) {
      if (row.pgid === group && !row.zombie) this.rows.set(processIdentity(row), row);
    }
  }

  /** Pids with owed restoration, including a leader's group when no descendant was recorded. */
  get pids(): readonly number[] {
    return [...this.rows.values()].map((row) => row.pid);
  }

  /** True once no debt remains: resumed, already running, gone, or replaced. */
  retry(table: readonly ProcessEntry[], ops: Pick<SweepOps, "continueGroup">): boolean {
    const pending = new Set<number>();
    for (const [id, held] of this.rows) {
      const row = table.find((candidate) => processIdentity(candidate) === id);
      if (row === undefined || row.zombie || !row.stopped || row.pgid !== held.pgid) {
        this.rows.delete(id);
      } else pending.add(row.pgid);
    }
    for (const group of pending) {
      try {
        ops.continueGroup(group);
      } catch (error) {
        if (errnoCode(error) !== "ESRCH") continue;
      }
      for (const [id, row] of this.rows) if (row.pgid === group) this.rows.delete(id);
    }
    return this.rows.size === 0;
  }
}
