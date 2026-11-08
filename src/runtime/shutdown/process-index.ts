/** Per-read PID, group and ancestry indexes for shutdown recovery (C-LIFE-10). */
import { processIndexBase } from "./process-index-base.ts";
import type { ProcessEntry } from "./process-table.ts";

type ProcessIndex = ReturnType<typeof processIndexBase> & {
  readonly byGroup: ReadonlyMap<number, readonly ProcessEntry[]>;
};
const indexes = new WeakMap<readonly ProcessEntry[], ProcessIndex>();

/** The immutable table object owns one index regardless of how many records read it. */
export function processIndex(table: readonly ProcessEntry[]): ProcessIndex {
  const cached = indexes.get(table);
  if (cached !== undefined) return cached;
  const byGroup = new Map<number, ProcessEntry[]>();
  for (const row of table) {
    const members = byGroup.get(row.pgid) ?? [];
    members.push(row);
    byGroup.set(row.pgid, members);
  }
  const index = { ...processIndexBase(table), byGroup };
  indexes.set(table, index);
  return index;
}
