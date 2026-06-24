/**
 * Best-effort teardown sequencing for owned runtime resources.
 * Implements PRD §8.4 and §10 teardown failure behavior.
 */

import { elwoodError } from "../core/errors.ts";

export async function runTeardownSteps(
  steps: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw elwoodError("teardown_failed", "Could not fully tear down Elwood session.", {
      causes: failures,
    });
  }
}
