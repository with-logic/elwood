/** Publish the initial-readiness backstop and its last settled screen (PRD §5.4, C-ATTN-06). */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../../core/activity/index.ts";
import { unrecognizedStartupActivity } from "../../core/activity/startup.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { initialBackstopMs } from "../readiness/initial-ready.ts";
import { createReadinessGate, type ReadinessGate } from "./readiness.ts";

type StartupDiagnostics = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly configured: (frame: string, cols?: number) => boolean;
  readonly warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void };
  readonly events: {
    emit(name: "activity", event: ElwoodActivityEvent, observeRejections: true): void;
  };
};

export function createStartupReadinessGate(
  onReady: () => void,
  resumed: boolean,
  { elwoodSessionId, agent, configured, warnings, events }: StartupDiagnostics,
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
      configured,
      onBackstop: (dialogHeld) => {
        const completed = screen;
        stopCapture();
        try {
          if (!dialogHeld)
            events.emit(
              "activity",
              unrecognizedStartupActivity(agent, elwoodSessionId, completed),
              true,
            );
        } finally {
          warnings.emitWarnings([
            {
              elwoodSessionId,
              agent,
              source: "lifecycle",
              code: "initial_ready_backstop",
              severity: "warning",
              message: `No configured ${agent === "claude" ? "Claude" : "Codex"} composer was recognized within ${initialBackstopMs / 1_000} seconds of the first frame; readiness and queued input remain held.`,
              raw: "initial_ready_backstop",
            },
          ]);
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
