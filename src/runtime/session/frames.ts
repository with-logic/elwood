/** Session-owned frame and trust-deadline observation (PRD §5.3/§5.4, C-TRUST-01). */
import {
  observeRenderedReading,
  type RenderedObservers,
  readRenderedFrame,
} from "../../core/rendered-observers.ts";
import type { RenderedFrame } from "../../core/screen-facts.ts";
import type { InitialReady } from "../readiness/initial-ready.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { ReadinessGate } from "./readiness.ts";

type FrameSession = Pick<
  SessionLifecycle,
  "closing" | "inputBlocking" | "automationBlocking" | "submitEvidence" | "status"
>;

type TrustState = {
  readonly inputBlocking: boolean;
  readonly blockedPrompt: string | undefined;
  dispose(): void;
};

/** Timers and PTY frames use the same guards, facts, and attention edge owner. */
export function createSessionFrameObserver(
  observers: RenderedObservers,
  session: () => FrameSession | undefined,
  trust: () => TrustState,
  readiness: ReadinessGate,
) {
  let frame: RenderedFrame | undefined;
  const refresh = () => {
    const active = session();
    if (active === undefined || active.closing.signal.aborted || frame === undefined) return;
    const state = trust();
    const reading = readRenderedFrame(observers, frame, state.blockedPrompt);
    const released = active.automationBlocking && !state.inputBlocking;
    active.automationBlocking = state.inputBlocking;
    active.inputBlocking = reading.facts.blocking_prompt_visible;
    readiness.ready.armDeadline();
    try {
      observeRenderedReading(observers, reading, active);
      // A human gate that handed off to an automation-owned one had its clear edge
      // ignored while automation held input. Only that edge may leave `blocked`, so
      // replay it once automation releases with nothing blocking left on screen.
      if (released && !reading.facts.blocking_prompt_visible)
        active.submitEvidence("blocking_prompt_cleared");
    } finally {
      readiness.observeReadinessFrame(reading.facts, active.automationBlocking);
    }
  };
  return {
    refresh,
    observe: (current: RenderedFrame) => {
      frame = current;
      refresh();
    },
  };
}

/** Cancel automation synchronously before signaling or disposing its PTY. */
export function bindStartupLifetime(
  session: Pick<SessionLifecycle, "closing">,
  trust: TrustState,
  ready: InitialReady,
): void {
  session.closing.signal.addEventListener(
    "abort",
    () => {
      trust.dispose();
      ready.cancel();
    },
    { once: true },
  );
}
