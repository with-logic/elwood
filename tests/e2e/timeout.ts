/**
 * The e2e suite's bound on one step (PRD §12): `ELWOOD_E2E_TIMEOUT_MS`, else three minutes.
 * Kept apart from `availability.ts`, which makes the run dir (`run-dir.ts`) when it loads, so
 * the bounded steps the unit suite loads leave nothing in the temp dir.
 */

export const e2eTimeoutMs = Number(process.env["ELWOOD_E2E_TIMEOUT_MS"] ?? 180_000);
