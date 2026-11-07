/** Retain identity-bound restoration debt after a failed SIGCONT (PRD §5.3, C-LIFE-10). */
import { errnoCode } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { SweepOps } from "./rounds.ts";

/** Per-read identity lookup shared by all records examining the same process table. */
const identityIndexes = new WeakMap<readonly ProcessEntry[], ReadonlyMap<string, ProcessEntry>>();
function processEntriesByIdentity(
  table: readonly ProcessEntry[],
): ReadonlyMap<string, ProcessEntry> {
  const cached = identityIndexes.get(table);
  if (cached !== undefined) return cached;
  const index = new Map(table.map((row) => [processIdentity(row), row]));
  identityIndexes.set(table, index);
  return index;
}

/** Live identities from a failed group restoration; retry only those still stopped there. */
export class ResumeDebt {
  private readonly rows = new Map<
    string,
    Pick<ProcessEntry, "pid" | "pgid"> & { readonly pendingStop?: true }
  >();

  remember(table: readonly ProcessEntry[], group: number): void {
    for (const row of table) {
      if (row.pgid === group && !row.zombie) this.rows.set(processIdentity(row), row);
    }
  }

  /** Preserve an unconfirmed STOP until its original member is stopped or gone. */
  rememberIdentity({
    identity,
    pid,
    pgid,
  }: {
    readonly identity: string;
    readonly pid: number;
    readonly pgid: number;
  }): void {
    this.rows.set(identity, { pid, pgid, pendingStop: true });
  }

  get pids(): readonly number[] {
    return [...this.rows.values()].map((row) => row.pid);
  }

  /** Resolve only a matching stopped identity, preserving failures independently per group. */
  retry(table: readonly ProcessEntry[], ops: Pick<SweepOps, "continueGroup">): boolean {
    if (this.rows.size === 0) return true;
    const current = processEntriesByIdentity(table);
    const pending = new Map<number, string[]>();
    for (const [id, held] of this.rows) {
      const row = current.get(id);
      if (
        held.pendingStop &&
        row !== undefined &&
        !row.zombie &&
        row.pgid === held.pgid &&
        !row.stopped
      )
        continue;
      if (!isOriginalStoppedMember(row, held.pgid)) {
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

function isOriginalStoppedMember(
  row: ProcessEntry | undefined,
  group: number,
): row is ProcessEntry {
  return row !== undefined && !row.zombie && row.stopped && row.pgid === group;
}
