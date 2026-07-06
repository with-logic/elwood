/**
 * Warning persistence and emission helpers for Codex sessions.
 * Implements PRD §5.7 and §8.2.
 */

import { activityFromWarning } from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import { type SessionRecord, upsertSessionWarning } from "../state/store.ts";
import type { CodexEventMap } from "./session-types.ts";

type CodexHomeWarning = Omit<
  Extract<ElwoodWarningEvent, { readonly code: "codex_home_hooks_disabled" }>,
  "elwoodSessionId"
>;

/** Codex's TUI skips all hook execution when CODEX_HOME is set (C-CODEX-14). */
export function codexHomeHooksWarning(): CodexHomeWarning | undefined {
  const codexHome = process.env["CODEX_HOME"];
  if (codexHome === undefined) return undefined;
  return {
    agent: "codex",
    source: "lifecycle",
    code: "codex_home_hooks_disabled",
    severity: "warning",
    message:
      "CODEX_HOME is set; the Codex TUI skips hook execution under a relocated home, so Elwood hook events will not fire.",
    raw: codexHome,
  };
}

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
