/** Per-read PID, group and ancestry indexes for shutdown recovery (C-LIFE-10). */
import { childrenByParent, type ProcessEntry } from "./process-table.ts";

type ProcessIndex = {
  readonly byPid: ReadonlyMap<number, ProcessEntry>;
  readonly byGroup: ReadonlyMap<number, readonly ProcessEntry[]>;
  readonly children: ReturnType<typeof childrenByParent>;
};
const indexes = new WeakMap<readonly ProcessEntry[], ProcessIndex>();

/** The immutable table object owns one index regardless of how many records read it. */
export function processIndex(table: readonly ProcessEntry[]): ProcessIndex {
  const cached = indexes.get(table);
  if (cached !== undefined) return cached;
  const byPid = new Map<number, ProcessEntry>();
  const byGroup = new Map<number, ProcessEntry[]>();
  for (const row of table) {
    byPid.set(row.pid, row);
    const members = byGroup.get(row.pgid) ?? [];
    members.push(row);
    byGroup.set(row.pgid, members);
  }
  const index = { byPid, byGroup, children: childrenByParent(table) };
  indexes.set(table, index);
  return index;
}
