/**
 * Inert detached-sweep operations for a `SessionReaper` built with a fake group kill
 * (C-LIFE-10). Spread in, they make the sweep that reaper drives list no processes and
 * stop nothing, so no unit test enumerates or signals a real process group through it.
 */

import type { ProcessTreeOps } from "../../src/runtime/shutdown/reap-tree.ts";

export const noDetachedSweep: Pick<ProcessTreeOps, "stopGroup" | "listProcesses"> = {
  stopGroup: () => {},
  listProcesses: async () => [],
};
