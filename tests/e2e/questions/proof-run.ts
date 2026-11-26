/** Run a public native question proof and its cleanup without losing its first failure (PRD §12). */
import type { TestContext } from "node:test";

/**
 * Runs a proof's steps, then each cleanup in order. The first failure is the one thrown; a later
 * one is only a diagnostic, so a cleanup error cannot hide the step that failed.
 */
export async function runPublicProof(
  t: Pick<TestContext, "diagnostic">,
  cleanups: readonly (() => unknown)[],
  steps: () => Promise<void>,
): Promise<void> {
  let failure: { readonly error: unknown } | undefined;
  for (const work of [steps, ...cleanups]) {
    try {
      await work();
    } catch (error) {
      if (failure) t.diagnostic(error instanceof Error ? error.message : String(error));
      else failure = { error };
    }
  }
  if (failure) throw failure.error;
}
