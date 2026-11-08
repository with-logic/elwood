/** Immutable snapshot indexes for caller-specific daemon marking (PRD §5.3, C-LIFE-10). */
import { childrenByParent, type ProcessEntry } from "./process-table.ts";

type DaemonIndex = {
  readonly byPid: ReadonlyMap<number, ProcessEntry>;
  readonly children: ReturnType<typeof childrenByParent>;
};
const indexes = new WeakMap<readonly ProcessEntry[], DaemonIndex>();

/** Reuse row names and ancestry without sharing any caller's daemon decisions. */
export function daemonIndex(table: readonly ProcessEntry[]): DaemonIndex {
  const cached = indexes.get(table);
  if (cached !== undefined) return cached;
  const byPid = new Map<number, ProcessEntry>();
  for (const row of table) byPid.set(row.pid, row);
  const index = { byPid, children: childrenByParent(table) };
  indexes.set(table, index);
  return index;
}
