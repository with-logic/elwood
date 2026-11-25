/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer), and missing evidence at the backstop is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28).
 */
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";
import type { CodexEventMap } from "./types.ts";

export function createCodexReadinessGate(
  onReady: () => void,
  resumed: boolean,
  elwoodSessionId: string,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
) {
  return createStartupReadinessGate(onReady, resumed, {
    session: { agent: "codex", elwoodSessionId },
    configured: codexComposerConfigured,
    warnings,
    events,
  });
}
