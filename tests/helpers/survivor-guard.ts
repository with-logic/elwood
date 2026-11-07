/** Explicit signal authority for private survivor-watch tests (PRD §5.3, C-LIFE-10). */
import type { LeaderSignalGuard } from "../../src/runtime/shutdown/detached-sweep/held-leader.ts";
import { SerialDetachedSweepQueue } from "../../src/runtime/shutdown/reap-queue.ts";

export function survivorGuard(): LeaderSignalGuard {
  const queue = new SerialDetachedSweepQueue();
  return {
    serialize: (attempt) => queue.run(attempt),
    assertRetainedAuthority: () => undefined,
    authorize: () => undefined,
    forbid: () => undefined,
    gone: () => undefined,
  };
}
