/**
 * Attempt-all sequencing for owned runtime resources: `runTeardownSteps` is the
 * §8.4 teardown (typed `teardown_failed`, §10) and `runCleanupSteps` is the §9.4
 * runtime-cleanup primitive every exit path shares (its caller wraps the failure).
 */

import { elwoodError } from "../../core/errors.ts";

/** Runs every step even if earlier ones reject, returning the collected failure messages. */
async function attemptAllSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

export async function runTeardownSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const failures = await attemptAllSteps(steps);
  if (failures.length > 0) {
    throw elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
      causes: failures,
    });
  }
}

/**
 * Runs every runtime-cleanup step even if one rejects, so a failing bridge stop still
 * disposes the terminal and finishes the transcript watcher — no resource is leaked
 * because an earlier step threw (PRD §9.4). Rejects with an aggregated Error whose
 * message lists each failure; upstream (`stopRuntime` callers) fold it into their own
 * typed error (`termination_failed`/`teardown_failed`) so no new public code appears.
 */
export async function runCleanupSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const failures = await attemptAllSteps(steps);
  if (failures.length > 0) throw new Error(`Runtime cleanup failed: ${failures.join("; ")}`);
}
