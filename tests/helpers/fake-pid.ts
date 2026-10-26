/**
 * The process ids fake PTYs and fake reap leaders use (PRD §5.3, C-LIFE-10). The reap
 * never signals the host's own process group, so a fake leader with the test runner's own
 * pid is never reaped, and a test expecting the reap fails. A fixed pid an OS can assign
 * becomes the runner's own once the pid counter wraps (macOS's runs to 99,999), as 1000
 * once did for a Vitest worker. These are above the largest pid any supported OS assigns,
 * so they are never the runner's, and a real `kill(2)` sent to one finds no process.
 */

/** The largest pid a supported OS assigns: Linux's `PID_MAX_LIMIT` (macOS's is 99,999). */
export const LARGEST_OS_PID = 4_194_304;

/** The first fake pid; fakes that need several count up from it. */
export const FAKE_PID = 10_000_000;
