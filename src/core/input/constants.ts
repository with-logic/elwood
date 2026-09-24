/** Shared composer keys and bounded input-recovery cadence (PRD §5.3, C-API-56). */

/** Ctrl+U kills to line start; Ctrl+K kills to line end, discarding staged composer content. */
export const composerClearKeys = "\u0015\u000b";
/** Recheck dialog, unobserved-output, and failed-render holds at the same cadence. */
export const unsafeWriteRetryMs = 50;

/** Maximum physical recovery Enters after the initial submitting Enter. */
export const pasteNudgeAttempts = 2;

/** Unknown/unsafe observations share one bounded recovery budget. */
export const pasteObservationLimit = 4;
