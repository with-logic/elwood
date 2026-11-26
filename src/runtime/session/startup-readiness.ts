/**
 * Publish an unrecognized startup screen from the readiness deadline, and the
 * initial-readiness backstop with its last settled screen (PRD §5.4, C-ATTN-06, C-ATTN-09).
 */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../../core/activity/index.ts";
import { unrecognizedStartupActivity } from "../../core/activity/startup.ts";
import { runContained } from "../../core/contained.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { cachedLiveSnapshot, settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { initialBackstopMs } from "../readiness/initial-ready.ts";
import { createReadinessGate, type ReadinessGate } from "./readiness.ts";

type StartupDiagnostics = {
  readonly session: { readonly agent: ElwoodAgentKind; readonly elwoodSessionId: string };
  readonly configured: (frame: string, cols?: number) => boolean;
  /** The adapter's own screens before its configured composer (C-ATTN-09). */
  readonly startupScreen?: (frame: string) => boolean;
  readonly warnings: {
    emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void;
    duringDelivery?(deliver: () => void): void;
  };
  readonly events: {
    emit(name: "activity", event: ElwoodActivityEvent, observeRejections: true): void;
  };
};

/**
 * Retain the last settled startup screen until readiness, cancellation, or the backstop.
 * The backstop emits a content-free warning. When no recognized dialog holds readiness
 * it also emits a bounded copy of the captured screen as activity. An unrecognized
 * startup screen's report is activity too, contained like the backstop's.
 */
export function createStartupReadinessGate(
  onReady: () => void,
  resumed: boolean,
  { session: { agent, elwoodSessionId }, configured, startupScreen, ...io }: StartupDiagnostics,
): ReadinessGate & { observeStartupFrame(terminal: ElwoodTerminal): TerminalSnapshot } {
  const { warnings, events } = io;
  const duringDelivery = warnings.duringDelivery ?? ((deliver: () => void) => deliver());
  let screen = "";
  let capture = true;
  // Whether the latest frame is a completed one, until readiness or cancellation.
  let watching = true;
  let completed = false;
  const stopCapture = () => {
    screen = "";
    capture = false;
  };
  const stopWatching = () => {
    stopCapture();
    watching = false;
  };
  const gate = createReadinessGate(
    () => {
      onReady();
      stopWatching();
    },
    resumed,
    {
      configured,
      startupScreen,
      completed: () => completed,
      report: (text) =>
        runContained(() =>
          events.emit(
            "activity",
            unrecognizedStartupActivity(agent, elwoodSessionId, text, "initial_ready_deadline"),
            true,
          ),
        ),
      onBackstop: (dialogHeld) => {
        const completed = screen;
        stopCapture();
        duringDelivery(() => {
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
        });
      },
    },
  );
  return {
    ...gate,
    ready: {
      ...gate.ready,
      cancel() {
        stopWatching();
        gate.ready.cancel();
      },
    },
    observeStartupFrame(terminal) {
      // A synchronized repaint can span PTY writes. Keep the previous settled text.
      const settled = watching ? settledLiveSnapshot(terminal) : undefined;
      completed = settled !== undefined;
      if (!settled) return cachedLiveSnapshot(terminal);
      if (capture) screen = settled.text;
      return settled;
    },
  };
}
