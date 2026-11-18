/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer), and missing evidence at the backstop is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28).
 */
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { initialBackstopMs } from "../../runtime/readiness/initial-ready.ts";
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
    onBackstop: () => warnings.emitWarnings([backstopWarning(elwoodSessionId)]),
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
    message: `No configured Codex composer was recognized within ${initialBackstopMs / 1_000} seconds of the first frame; readiness and queued input remain held.`,
    raw: "initial_ready_backstop",
  };
}
