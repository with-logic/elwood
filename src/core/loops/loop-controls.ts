/** Shared recurring-loop control contract. Implements PRD §5.8/§5.9 and C-LOOP-01/C-LOOP-20. */

import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "./types.ts";

export interface LoopControls {
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot>;
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]>;
  cancelLoop(loopId: string): Promise<void>;
}
