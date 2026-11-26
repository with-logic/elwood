/**
 * Publish an unrecognized startup screen from the readiness deadline, and the
 * initial-readiness backstop with its last settled screen (PRD §5.4, C-ATTN-06, C-ATTN-11).
 */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../../core/activity/index.ts";
import { unrecognizedStartupActivity } from "../../core/activity/startup.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import { cachedLiveSnapshot, settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { initialBackstopMs } from "../readiness/initial-ready.ts";
import { createReadinessGate, type ReadinessGate, type SettledFrame } from "./readiness.ts";

type StartupDiagnostics = {
  readonly session: { readonly agent: ElwoodAgentKind; readonly elwoodSessionId: string };
  readonly configured: (frame: string, cols?: number) => boolean;
  /** The adapter's own screens before its configured composer (C-ATTN-11). */
  readonly nativeStartupScreen: (frame: string, cols?: number) => boolean;
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
 * The backstop emits a content-free warning. When no recognized dialog or startup
 * automation holds readiness it also emits a bounded copy of the captured screen as
 * activity. An unrecognized startup screen's report is activity too, emitted while a frame
 * is observed. The deadline re-reads the terminal, which a resize can have reflowed, and so
 * does `rereadFrame`, for an adapter whose evidence changes with time rather than a repaint.
 */
export function createStartupReadinessGate(
  onReady: () => void,
  resumed: boolean,
  {
    session: { agent, elwoodSessionId },
    configured,
    nativeStartupScreen,
    warnings,
    events,
  }: StartupDiagnostics,
): ReadinessGate & {
  observeStartupFrame(terminal: ElwoodTerminal): TerminalSnapshot;
  rereadFrame(): void;
} {
  const duringDelivery = warnings.duringDelivery ?? ((deliver: () => void) => deliver());
  let screen = "";
  let capture = true;
  // Frames are watched until readiness or cancellation.
  let watching = true;
  // The live terminal and its last settled text, kept to reject a stale frame at the deadline.
  let terminal: ElwoodTerminal | undefined;
  let completedText: string | undefined;
  // Read when a frame is classified, which the deadline can do long after it rendered: output
  // since then, or a repaint in progress, makes the frame stale rather than completed.
  const frameCompleted = () =>
    watching &&
    terminal !== undefined &&
    completedText !== undefined &&
    settledLiveSnapshot(terminal)?.text === completedText;
  /** Settle on the terminal's current frame, or on no completed frame while it repaints. */
  const settle = (from: ElwoodTerminal): TerminalSnapshot | undefined => {
    terminal = from;
    const settled = watching ? settledLiveSnapshot(from) : undefined;
    completedText = settled?.text;
    if (settled && capture) screen = settled.text;
    return settled;
  };
  // At the deadline a resize can have reflowed the screen without the CLI repainting it.
  const deadlineFrame = (): SettledFrame | undefined => {
    const settled = terminal && settle(terminal);
    return settled && { text: settled.text, cols: settled.cols };
  };
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
      nativeStartupScreen,
      completed: frameCompleted,
      // A listener that throws reaches the frame observer, which reports it (C-API-72).
      report: (text) =>
        events.emit(
          "activity",
          unrecognizedStartupActivity(agent, elwoodSessionId, text, "initial_ready_deadline"),
          true,
        ),
      onBackstop: (recognizedHold) => {
        const backstopScreen = screen;
        stopCapture();
        duringDelivery(() => {
          try {
            if (!recognizedHold)
              events.emit(
                "activity",
                unrecognizedStartupActivity(agent, elwoodSessionId, backstopScreen),
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
  let deadlineListener: ((current?: SettledFrame) => void) | undefined;
  const rereadFrame = () => deadlineListener?.(deadlineFrame());
  gate.setDeadlineListener(rereadFrame);
  return {
    ...gate,
    setDeadlineListener: (listener) => {
      deadlineListener = listener;
    },
    rereadFrame,
    ready: {
      ...gate.ready,
      cancel() {
        stopWatching();
        gate.ready.cancel();
      },
    },
    observeStartupFrame(rendered) {
      // A synchronized repaint can span PTY writes. Keep the previous settled text.
      return settle(rendered) ?? cachedLiveSnapshot(rendered);
    },
  };
}
