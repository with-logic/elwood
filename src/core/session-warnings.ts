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
    if (result.changed) persist(result.record);
    if (result.isNew) {
      emit.warning(warning);
      emit.activity(activityFromWarning(warning));
    }
    current = result.record;
  }
}
