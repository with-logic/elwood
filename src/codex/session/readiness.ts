/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the model
 * footer), and a release by the backstop without one is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28).
 */
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { createReadinessGate, type ReadinessGate } from "../../runtime/session/readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";

export function createCodexReadinessGate(
  onReady: () => void,
  resumed: boolean,
  elwoodSessionId: string,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
): ReadinessGate {
  return createReadinessGate(onReady, resumed, {
    configured: codexComposerConfigured,
    onBackstopRelease: () => warnings.emitWarnings([backstopWarning(elwoodSessionId)]),
  });
}

/** Live-only and content-free: it names the missing evidence, never the screen. */
function backstopWarning(elwoodSessionId: string): InitialReadyBackstopWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "initial_ready_backstop",
    severity: "warning",
    message:
      "No configured Codex composer was recognized within 60 seconds of the first frame; readiness was released without it.",
    raw: "initial_ready_backstop",
  };
}
