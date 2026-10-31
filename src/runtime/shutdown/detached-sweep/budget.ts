/**
 * The detached walk's deadline (PRD §5.3 and §9.4, C-LIFE-10), which the survivor reap
 * and each process-table read in `stop()`’s descendant watch share. It lives in a module of its own because
 * `index.ts` imports `record.ts`, so `record.ts` reading it from `index.ts` would be an
 * import cycle, which leaves it uninitialized when `record.ts` loads first.
 */

/**
 * The whole sweep's deadline. A hook that started a setsid child of its own takes six
 * reads, and on a loaded host one read can take over half a second (docs/cli-behavior.md).
 */
export const DETACHED_SWEEP_BUDGET_MS = 10_000;
