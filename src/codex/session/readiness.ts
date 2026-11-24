/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer), and missing evidence at the backstop is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28).
 */
import { unrecognizedStartupActivity } from "../../core/activity/startup.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { initialBackstopMs } from "../../runtime/readiness/initial-ready.ts";
import { createReadinessGate, type ReadinessGate } from "../../runtime/session/readiness.ts";
import { settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";
import type { CodexEventMap } from "./types.ts";

export function createCodexReadinessGate(
  onReady: () => void,
  resumed: boolean,
  elwoodSessionId: string,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
): ReadinessGate & { captureStartupScreen(terminal: ElwoodTerminal): void } {
  let screen = "";
  let capture = true;
  const stopCapture = () => {
    screen = "";
    capture = false;
  };
  const gate = createReadinessGate(
    () => {
      onReady();
      stopCapture();
    },
    resumed,
    {
      configured: codexComposerConfigured,
      onBackstop: (dialogHeld) => {
        const completed = screen;
        stopCapture();
        try {
          if (!dialogHeld)
            events.emit("activity", unrecognizedStartupActivity(elwoodSessionId, completed), true);
        } finally {
          warnings.emitWarnings([backstopWarning(elwoodSessionId)]);
        }
      },
    },
  );
  return {
    ...gate,
    captureStartupScreen(terminal) {
      // A synchronized repaint can span PTY writes. Keep the previous settled text.
      if (capture) screen = settledLiveSnapshot(terminal)?.text ?? screen;
    },
  };
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
