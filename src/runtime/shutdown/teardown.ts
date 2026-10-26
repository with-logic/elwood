/**
 * Attempt-all sequencing for owned runtime resources: `runTeardownSteps` is the
 * §8.4 teardown (typed `teardown_failed`, §10) and `runCleanupSteps` is the §9.4
 * runtime-cleanup primitive every exit path shares (its caller wraps the failure).
 */

import { ElwoodError, type ElwoodErrorName, elwoodError, toError } from "../../core/errors.ts";

/** One failed teardown step: its message, plus its code and details when it was typed. */
export type TeardownFailure =
  | { readonly message: string }
  | {
      readonly message: string;
      readonly code: ElwoodErrorName;
      readonly details: Readonly<Record<string, unknown>>;
    };

/** Runs every step even if earlier ones reject, returning what each failed step threw. */
async function attemptAllSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Runs every teardown step, then rejects with `teardown_failed` if any failed. Its
 * `details.causes` lists each failure's message, and `details.failures` keeps each
 * typed failure's code and details too, so a reap failure's errno or process group
 * survives teardown (§10).
 */
export async function runTeardownSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const failures = (await attemptAllSteps(steps)).map(teardownFailure);
  if (failures.length > 0) {
    throw elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
      causes: failures.map((failure) => failure.message),
      failures,
    });
  }
}

function teardownFailure(error: unknown): TeardownFailure {
  const { message } = toError(error);
  if (!(error instanceof ElwoodError)) return { message };
  return { message, code: error.code, details: error.details };
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
  const failures = (await attemptAllSteps(steps)).map((error) => toError(error).message);
  if (failures.length > 0) throw new Error(`Runtime cleanup failed: ${failures.join("; ")}`);
}
