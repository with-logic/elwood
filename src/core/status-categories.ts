/**
 * Single source of truth for session-status literals and their categories.
 * `ElwoodSessionStatus` is derived from these tuples, and validation and the
 * live/terminal category sets are built from the same source — so adding a
 * status is one edit and cannot silently desync the type, persistence
 * validation, or lifecycle guards.
 * Implements PRD §5 lifecycle guarantees.
 */

/** Statuses of a started, not-yet-terminated interactive session. */
export const liveStatusList = ["running", "ready", "blocked"] as const;
/** Statuses a session cannot leave under normal work (teardown may supersede). */
export const terminalStatusList = ["exited", "stopped", "killed", "torn_down"] as const;
/** The pre-live bootstrap status, before startup health has produced a live one. */
export const startingStatus = "starting" as const;

export const allStatusList = [startingStatus, ...liveStatusList, ...terminalStatusList] as const;

export type ElwoodSessionStatus = (typeof allStatusList)[number];

/** Statuses a session cannot leave under normal work; teardown may still supersede. */
export const terminalStatuses: ReadonlySet<ElwoodSessionStatus> = new Set(terminalStatusList);
/** Statuses of a started, not-yet-terminated interactive session. */
export const liveStatuses: ReadonlySet<ElwoodSessionStatus> = new Set(liveStatusList);
/** Every valid persisted status, for state-record validation. */
export const allStatuses: ReadonlySet<ElwoodSessionStatus> = new Set(allStatusList);
