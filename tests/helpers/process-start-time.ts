/** Shared second-resolution process-start precondition for real shutdown tests (C-LIFE-10). */

/** Cross the one-second `ps lstart` interval, with a 100 ms scheduling margin. */
export const DISTINCT_PROCESS_START_DELAY_MS = 1_100;
