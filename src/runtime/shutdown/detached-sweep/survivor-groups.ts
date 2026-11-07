/** Traverse all recorded survivor roots together, once per read (C-LIFE-10). */
import { processIndex } from "../process-index.ts";
import type { ProcessEntry } from "../process-table.ts";

/** The safe survivor groups and every detached descendant group their members anchor. */
export function survivorDescendantGroups(
  survivors: readonly ProcessEntry[],
  table: readonly ProcessEntry[],
): ReadonlyMap<number, ReadonlySet<ProcessEntry>> {
  const { byPid, byGroup, children } = processIndex(table);
  const hostGroup = byPid.get(process.pid)?.pgid;
  const roots = new Set(
    survivors.map((row) => row.pgid).filter((group) => group > 1 && group !== hostGroup),
  );
  const groups = new Map<number, Set<ProcessEntry>>([...roots].map((group) => [group, new Set()]));
  const pending: ProcessEntry[] = [];
  for (const [group, members] of byGroup) {
    if (roots.has(group)) pending.push(...members.filter((row) => !(row.zombie || row.shared)));
  }
  const visited = new Set(pending.map((row) => row.pid));
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (visited.has(child.pid) || child.shared) continue;
      visited.add(child.pid);
      pending.push(child);
      if (child.zombie || child.pgid <= 1 || child.pgid === hostGroup) continue;
      const parents = groups.get(child.pgid) ?? new Set<ProcessEntry>();
      if (parent.pgid !== child.pgid) parents.add(parent);
      groups.set(child.pgid, parents);
    }
  }
  return groups;
}
