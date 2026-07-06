/**
 * Warning persistence and emission helpers for Codex sessions.
 * Implements PRD §5.7 and §8.2.
 */

import { activityFromWarning } from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import { type SessionRecord, upsertSessionWarning } from "../state/store.ts";
import type { CodexEventMap } from "./session-types.ts";

export function recordCodexWarnings(
  record: SessionRecord,
  warnings: readonly ElwoodWarningEvent[],
  persist: (record: SessionRecord) => void,
  emitter: TypedEmitter<CodexEventMap>,
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
