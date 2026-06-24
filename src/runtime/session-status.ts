/**
 * Shared lifecycle status helpers for in-memory sessions.
 * Implements PRD §5 lifecycle guarantees.
 */

import type { ElwoodSessionStatus } from "../core/types.ts";

export const terminalStatuses = new Set<ElwoodSessionStatus>([
  "exited",
  "stopped",
  "killed",
  "torn_down",
]);

export function canTransition(current: ElwoodSessionStatus, next: ElwoodSessionStatus): boolean {
  if (current === next) return false;
  if (current === "torn_down") return false;
  if (current === "killed" && next === "stopped") return false;
  if (terminalStatuses.has(current) && (next === "running" || next === "ready")) return false;
  return true;
}
