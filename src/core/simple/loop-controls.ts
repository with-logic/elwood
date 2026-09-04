/**
 * Shared recurring-loop control contract and lazy-session delegation helpers.
 * Implements PRD §5.8/§5.9 and C-LOOP-01/C-LOOP-20.
 */

import type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../loops/types.ts";

export interface LoopControls {
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot>;
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]>;
  cancelLoop(loopId: string): Promise<void>;
}

export function delegateCreateLoop(
  session: Promise<LoopControls>,
  request: ElwoodLoopRequest,
): Promise<ElwoodLoopSnapshot> {
  return session.then((live) => live.createLoop(request));
}

export function delegateListLoops(
  session: Promise<LoopControls>,
): Promise<readonly ElwoodLoopSnapshot[]> {
  return session.then((live) => live.listLoops());
}

export function delegateCancelLoop(session: Promise<LoopControls>, loopId: string): Promise<void> {
  return session.then((live) => live.cancelLoop(loopId));
}
