/**
 * Shared lifecycle status helpers for in-memory sessions.
 * Implements PRD §5 lifecycle guarantees.
 */

import { terminalStatuses } from "../core/status-categories.ts";
import type { ElwoodSessionStatus } from "../core/types.ts";

export { terminalStatuses };

export function canTransition(current: ElwoodSessionStatus, next: ElwoodSessionStatus): boolean {
  if (current === next) return false;
  if (current === "torn_down") return false;
  // `teardown` is the final cleanup and may supersede any earlier terminal
  // status (e.g. tearing down an already-exited session).
  if (next === "torn_down") return true;
  // Otherwise a terminated session keeps its first terminal status: no
  // terminal status transitions to another, so a racing `exited` cannot
  // override a controlled `stopped`/`killed`.
  if (terminalStatuses.has(current)) return false;
  return true;
}
