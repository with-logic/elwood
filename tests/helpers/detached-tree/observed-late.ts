/** Releases the late-on-TERM fixture only after a caller-approved row is observed (C-LIFE-10). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEntry } from "../../../src/runtime/shutdown/process-table.ts";
import {
  osProcessTreeOps,
  type ProcessTreeOps,
} from "../../../src/runtime/shutdown/process-tree-ops.ts";
import type { DetachedTree } from "../detached-tree.ts";

export function markingLateSeen(
  tree: DetachedTree,
  accepts: (row: ProcessEntry) => boolean,
): ProcessTreeOps["listProcesses"] {
  return async (timeoutMs, scope) => {
    const table = await osProcessTreeOps.listProcesses(timeoutMs, scope);
    const file = join(tree.dir, "late.pid");
    const late = existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
    if (table.some((row) => row.pid === late && accepts(row)))
      writeFileSync(join(tree.dir, "seen"), "");
    return table;
  };
}
