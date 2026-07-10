/**
 * Warning persistence and emission helpers for Codex sessions.
 * Implements PRD §5.7 and §8.2.
 */

import { recordSessionWarnings } from "../core/session-warnings.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { SessionRecord } from "../state/store.ts";
import type { CodexEventMap } from "./session-types.ts";

export function recordCodexWarnings(
  record: SessionRecord,
  warnings: readonly ElwoodWarningEvent[],
  persist: (record: SessionRecord) => void,
  emitter: TypedEmitter<CodexEventMap>,
): void {
  // No cast: each callback is the emitter's own `emit` bound to a correlated
  // event name, so a map/payload drift is a compile error here.
  recordSessionWarnings(record, warnings, persist, {
    warning: (event) => emitter.emit("warning", event),
    activity: (event) => emitter.emit("activity", event),
  });
}
