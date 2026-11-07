/** Shared second-resolution process-start precondition for real shutdown tests (C-LIFE-10). */

/** Cross ps’s timestamp uncertainty interval, with a 100 ms scheduling margin. */
export const DISTINCT_PROCESS_START_DELAY_MS = process.platform === "linux" ? 2_100 : 1_100;
