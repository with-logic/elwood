/**
 * Shared warning persistence and emission for all adapter sessions.
 * Implements PRD §5.7 and §8.2: warnings are de-duplicated into the session
 * snapshot, persisted when the snapshot changes, and emitted as `warning` +
 * `activity` only on first observation of a given warning key.
 */

import { type SessionRecord, upsertSessionWarning } from "../state/store.ts";
import { activityFromWarning } from "./activity.ts";
import type { ElwoodWarningEvent } from "./types.ts";

/** The minimal emitter surface a warning recorder needs (both adapter maps satisfy it). */
export type WarningEmitter = {
  emit(event: "warning", payload: ElwoodWarningEvent): void;
  emit(event: "activity", payload: ReturnType<typeof activityFromWarning>): void;
};

export function recordSessionWarnings(
  record: SessionRecord,
  warnings: readonly ElwoodWarningEvent[],
  persist: (record: SessionRecord) => void,
  emitter: WarningEmitter,
): void {
  let current = record;
  for (const warning of warnings) {
    const result = upsertSessionWarning(current, warning);
    if (result.changed) persist(result.record);
    if (result.isNew) {
      emitter.emit("warning", warning);
      emitter.emit("activity", activityFromWarning(warning));
    }
    current = result.record;
  }
}
