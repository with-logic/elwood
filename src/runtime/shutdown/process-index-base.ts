/** Shared PID/name and ancestry indexes for one immutable process snapshot (PRD §5.3, C-LIFE-10). */
import { childrenByParent, type ProcessEntry } from "./process-table.ts";

type ProcessIndexBase = {
  readonly byPid: ReadonlyMap<number, ProcessEntry>;
  readonly children: ReturnType<typeof childrenByParent>;
};
const indexes = new WeakMap<readonly ProcessEntry[], ProcessIndexBase>();

/** Reuse row names and ancestry; survivor group indexing remains a separate lazy step. */
export function processIndexBase(table: readonly ProcessEntry[]): ProcessIndexBase {
  const cached = indexes.get(table);
  if (cached !== undefined) return cached;
  const byPid = new Map<number, ProcessEntry>();
  for (const row of table) byPid.set(row.pid, row);
  const index = { byPid, children: childrenByParent(table) };
  indexes.set(table, index);
  return index;
}
