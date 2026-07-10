/**
 * Warning persistence and emission helpers for Codex sessions.
 * Implements PRD §5.7 and §8.2.
 */

import { recordSessionWarnings, type WarningEmitter } from "../core/session-warnings.ts";
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
  recordSessionWarnings(record, warnings, persist, emitter as WarningEmitter);
}
