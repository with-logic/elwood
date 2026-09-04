/**
 * Contain non-critical observer failures so they cannot control runtime progress.
 * Implements PRD §5.4 and §5.9 event-delivery isolation.
 */

/** Run a notification step without allowing observer failures to escape. */
export function runContained(step: () => void): void {
  try {
    step();
  } catch {
    // Observers are telemetry, never control flow.
  }
}
