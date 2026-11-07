/** Retain identity-bound restoration debt after a failed SIGCONT (PRD §5.3, C-LIFE-10). */
import { errnoCode } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { SweepOps } from "./rounds.ts";

/** Per-read identity lookup shared by all records examining the same process table. */
const identityIndexes = new WeakMap<readonly ProcessEntry[], ReadonlyMap<string, ProcessEntry>>();
function identitiesIn(table: readonly ProcessEntry[]): ReadonlyMap<string, ProcessEntry> {
  const cached = identityIndexes.get(table);
  if (cached !== undefined) return cached;
  const index = new Map(table.map((row) => [processIdentity(row), row]));
  identityIndexes.set(table, index);
  return index;
}

/** The stopped identities whose owning signal pass could not restore their group. */
export class ResumeDebt {
  private readonly rows = new Map<string, ProcessEntry>();

  remember(table: readonly ProcessEntry[], group: number): void {
    for (const row of table) {
      if (row.pgid === group && !row.zombie) this.rows.set(processIdentity(row), row);
    }
  }

  get pids(): readonly number[] {
    return [...this.rows.values()].map((row) => row.pid);
  }

  /** Resolve only a matching stopped identity, preserving failures independently per group. */
  retry(table: readonly ProcessEntry[], ops: Pick<SweepOps, "continueGroup">): boolean {
    const current = identitiesIn(table);
    const pending = new Map<number, string[]>();
    for (const [id, held] of this.rows) {
      const row = current.get(id);
      if (row === undefined || row.zombie || !row.stopped || row.pgid !== held.pgid) {
        this.rows.delete(id);
        continue;
      }
      const members = pending.get(row.pgid) ?? [];
      members.push(id);
      pending.set(row.pgid, members);
    }
    for (const [group, members] of pending) {
      try {
        ops.continueGroup(group);
      } catch (error) {
        if (errnoCode(error) !== "ESRCH") continue;
      }
      for (const id of members) this.rows.delete(id);
    }
    return this.rows.size === 0;
  }
}
