/**
 * Shared warning persistence and emission for all adapter sessions.
 * Implements PRD §5.7 and §8.2: warnings are de-duplicated into the session
 * snapshot, persisted when the snapshot changes, and emitted as `warning` +
 * `activity` only on first observation of a given warning key.
 */

import { type SessionRecord, upsertSessionWarning } from "../state/store.ts";
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

export function recordSessionWarnings(
  record: SessionRecord,
  warnings: readonly ElwoodWarningEvent[],
  persist: (record: SessionRecord) => void,
  emit: WarningEmit,
): void {
  let current = record;
  for (const warning of warnings) {
    const result = upsertSessionWarning(current, warning);
    current = result.record;
    // Deliver the user-facing signal BEFORE persistence and ISOLATE the two
    // emits: a disk failure must not drop the warning/activity a caller relies on,
    // and one throwing listener must not suppress the other event. The first
    // listener error is rethrown after both fire + persistence is attempted, so an
    // enclosing boundary still sees it.
    let firstError: unknown;
    if (result.isNew) {
      firstError = deliver(() => emit.warning(warning));
      firstError = deliver(() => emit.activity(activityFromWarning(warning)), firstError);
    }
    if (result.changed) persist(result.record);
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
