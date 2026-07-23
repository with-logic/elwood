/**
 * Live-only warning emission helper for Codex sessions.
 * Implements PRD §5.7: warnings are emitted once when observed, never persisted.
 */

import { emitSessionWarnings } from "../core/session-warnings.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { CodexEventMap } from "./session-types.ts";

export function recordCodexWarnings(
  warnings: readonly ElwoodWarningEvent[],
  emitter: TypedEmitter<CodexEventMap>,
): void {
  // No cast: each callback is the emitter's own `emit` bound to a correlated
  // event name, so a map/payload drift is a compile error here.
  emitSessionWarnings(warnings, {
    warning: (event) => emitter.emit("warning", event),
    activity: (event) => emitter.emit("activity", event),
  });
}
