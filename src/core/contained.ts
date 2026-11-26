/**
 * Contain non-critical observer failures so they cannot control runtime progress.
 * Implements PRD §5.4 and §5.9 event-delivery isolation.
 */

/**
 * Run every step even when one throws, then rethrow the first failure: a throwing
 * listener cannot skip the notifications after it, and an enclosing boundary still sees it.
 */
export function runEach(...steps: readonly (() => unknown)[]): void {
  let failure: { readonly error: unknown } | undefined;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** Run a notification step without allowing observer failures to escape. */
export function runContained(step: () => void): void {
  try {
    step();
  } catch {
    // Observers are telemetry, never control flow.
  }
}
