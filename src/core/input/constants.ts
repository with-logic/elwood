/** Shared composer keys and unsafe-input polling cadence (PRD §5.3, C-API-56). */

/** Ctrl+U kills to line start; Ctrl+K kills to line end, discarding staged composer content. */
export const composerClearKeys = "\u0015\u000b";
/** Recheck dialog, unobserved-output, and failed-render holds at the same cadence. */
export const unsafeWriteRetryMs = 50;
