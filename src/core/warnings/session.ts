/**
 * Shared live-only warning emission for all adapter sessions.
 * Implements PRD §5.7: a warning is emitted ONCE when observed, as a `warning`
 * event plus its `activity`, and is never persisted, replayed, or counted here.
 * Producers may deduplicate before emission, such as one transcript listener-error
 * warning per channel per watcher. This emitter delivers every supplied warning.
 */

import { activityFromWarning, type ElwoodActivityEvent } from "../activity/index.ts";
import type { ElwoodWarningEvent } from "../types.ts";

/**
 * Separately-typed emit callbacks for the two events a warning produces. Each
 * adapter supplies its own emitter's `emit` bound to the correlated event name,
 * so a mismatch between an adapter's event map and these payload types is a
 * compile error at the call site — no unchecked cast bridges the two.
 */
export type WarningEmit = {
  readonly warning: (event: ElwoodWarningEvent) => void;
  readonly activity: (event: ElwoodActivityEvent) => void;
};

export function emitSessionWarnings(
  warnings: readonly ElwoodWarningEvent[],
  emit: WarningEmit,
): void {
  // EVERY warning (and both of its two events) is attempted, even if an earlier
  // listener throws — a throwing listener for warning #1 must not silently drop
  // warnings #2+, whose identities/buffer were already consumed upstream and cannot
  // be recovered. The FIRST error is retained and rethrown only after the whole batch
  // fired, so an enclosing boundary still sees a failure without losing siblings.
  let firstError: unknown;
  for (const warning of warnings) {
    firstError = deliver(() => emit.warning(warning), firstError);
    firstError = deliver(() => emit.activity(activityFromWarning(warning)), firstError);
  }
  if (firstError !== undefined) throw firstError;
}

/** Run a fan-out step; return the FIRST error seen so both steps always run. */
function deliver(step: () => void, prior?: unknown): unknown {
  try {
    step();
    return prior;
  } catch (error) {
    return prior ?? error;
  }
}
