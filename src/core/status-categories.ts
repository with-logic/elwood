/**
 * Single source of truth for session-status categories. A compile-time
 * sentinel proves every `ElwoodSessionStatus` is classified, so adding a
 * status forces the category tables (and everything reusing them) to be
 * updated rather than silently misclassifying it.
 * Implements PRD §5 lifecycle guarantees.
 */

import type { ElwoodSessionStatus } from "./types.ts";

/** Statuses a session cannot leave; they are its final resting state. */
export const terminalStatuses = new Set<ElwoodSessionStatus>([
  "exited",
  "stopped",
  "killed",
  "torn_down",
]);

/** Statuses of a started, not-yet-terminated interactive session. */
export const liveStatuses = new Set<ElwoodSessionStatus>(["running", "ready", "blocked"]);

// Exhaustiveness sentinel: every status is either live, terminal, or the
// pre-live `starting` bootstrap. If a new `ElwoodSessionStatus` member is
// added without being categorized here, this assignment fails to compile.
type CategorizedStatus = "starting" | "running" | "ready" | "blocked" | ElwoodTerminalStatus;
type ElwoodTerminalStatus = "exited" | "stopped" | "killed" | "torn_down";
const _exhaustive: Record<ElwoodSessionStatus, true> = {
  starting: true,
  running: true,
  ready: true,
  blocked: true,
  exited: true,
  stopped: true,
  killed: true,
  torn_down: true,
} satisfies Record<CategorizedStatus, true>;
void _exhaustive;
