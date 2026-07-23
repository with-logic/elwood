/**
 * Shared live-only warning emission for all adapter sessions.
 * Implements PRD §5.7: a warning is emitted ONCE when observed, as a `warning`
 * event plus its `activity`, and is never persisted, replayed, deduplicated, or
 * counted. This mirrors the human experience — a banner flashes live, then it's gone.
 */

import { activityFromWarning, type ElwoodActivityEvent } from "./activity.ts";
import type { ElwoodWarningEvent } from "./types.ts";

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
  for (const warning of warnings) {
    // ISOLATE the two emits: one throwing listener must not suppress the other
    // event. The first listener error is rethrown after both fire, so an enclosing
    // boundary still sees it.
    let firstError = deliver(() => emit.warning(warning));
    firstError = deliver(() => emit.activity(activityFromWarning(warning)), firstError);
    if (firstError !== undefined) throw firstError;
  }
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
