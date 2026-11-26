/**
 * Wait bounds that the real-Codex update offer tests share (PRD §12; C-E2E-27, C-E2E-33).
 */

/** A first launch in a fresh home paints the offer later than a resume does. */
export const firstLaunchOfferMs = 30_000;

/**
 * Headroom past a test's last wait for its end to stop Codex, confirm that every process it
 * started is gone, and remove the scratch home.
 */
export const testEndReserveMs = 30_000;
