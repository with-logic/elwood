/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer), and missing evidence at the backstop is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28).
 */
import {
  type UnrecognizedStartupActivity,
  unrecognizedStartupActivity,
} from "../../core/activity/startup.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { initialBackstopMs } from "../../runtime/readiness/initial-ready.ts";
import { createReadinessGate, type ReadinessGate } from "../../runtime/session/readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";

export function codexReadiness(
  onReady: () => void,
  resumed: boolean,
  elwoodSessionId: string,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
  events: {
    emit(event: "activity", activity: UnrecognizedStartupActivity, containRejections: true): void;
  },
): ReadinessGate {
  return createReadinessGate(onReady, resumed, {
    configured: codexComposerConfigured,
    onBackstop: (screen) => {
      try {
        if (screen !== undefined)
          events.emit("activity", unrecognizedStartupActivity(elwoodSessionId, screen), true);
      } finally {
        warnings.emitWarnings([backstopWarning(elwoodSessionId)]);
      }
    },
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
