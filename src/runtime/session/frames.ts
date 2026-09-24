/** Session-owned frame and trust-deadline observation (PRD §5.3/§5.4, C-TRUST-01). */
import { activityFromAttention, blockingRuleIds } from "../../core/attention.ts";
import {
  observeRenderedReading,
  type RenderedObservers,
  readRenderedFrame,
} from "../../core/rendered-observers.ts";
import type { RenderedFrame, ScreenFacts } from "../../core/screen-facts.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { createAttentionClearance } from "./attention-clearance.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { ReadinessGate } from "./readiness.ts";

type FrameSession = Pick<
  SessionLifecycle,
  | "closing"
  | "inputBlocking"
  | "trustInputBlocking"
  | "submitEvidence"
  | "status"
  | "observeNativeWork"
>;

type TrustState = {
  readonly inputBlocking: boolean;
  readonly blockedPrompt: string | undefined;
  dispose(): void;
  observeClearance?(frame: string): void;
};

/** Timers and PTY frames use the same guards, facts, and attention edge owner. */
export function createSessionFrameObserver(
  observers: RenderedObservers,
  session: () => FrameSession | undefined,
  trust: () => TrustState,
  readiness: ReadinessGate,
  isIdleComposer: TrustClearance,
) {
  const attentionClearance = createAttentionClearance(isIdleComposer);
  let frame: RenderedFrame | undefined;
  let ruleIds: readonly string[] = [];
  let pendingAutomationClearance = false;
  const replayAutomationClearance = (active: FrameSession, facts: ScreenFacts) => {
    if (
      pendingAutomationClearance &&
      active.status === "blocked" &&
      !active.trustInputBlocking &&
      !active.inputBlocking &&
      (facts.working_visible || facts.composer_visible)
    ) {
      if (facts.working_visible) {
        observers.turn.adoptWorkingClearance(facts);
        active.observeNativeWork(
          observers.turn.nativeWorkingVisible,
          observers.turn.nativeComposerQuiet,
        );
      }
      active.submitEvidence("blocking_prompt_cleared", facts.working_visible);
    }
    if (active.status !== "blocked") pendingAutomationClearance = false;
  };
  const refresh = () => {
    const active = session();
    if (active === undefined || active.closing.signal.aborted || frame === undefined) return;
    const state = trust();
    const reading = attentionClearance(
      readRenderedFrame(observers, frame, state.blockedPrompt, state.inputBlocking),
      frame.text,
      state.inputBlocking,
    );
    const released = active.trustInputBlocking && !state.inputBlocking;
    active.trustInputBlocking = state.inputBlocking;
    active.inputBlocking =
      reading.facts.blocking_prompt_visible ||
      (active.inputBlocking && !reading.facts.working_visible && !reading.facts.composer_visible);
    const currentRuleIds = blockingRuleIds(reading);
    if (currentRuleIds.length > 0 || !active.inputBlocking) ruleIds = currentRuleIds;
    if (released && active.status === "blocked") pendingAutomationClearance = true;
    // Settle automation against this frame before evidence/readiness releases input.
    state.observeClearance?.(frame.text);
    // Publish this frame's hold before evidence listeners can submit readiness.
    readiness.observeFrameHold(reading.facts, active.trustInputBlocking);
    readiness.ready.armDeadline();
    try {
      observeRenderedReading(observers, reading, active);
      // Automation can consume the human clear edge. Retain its replay until a
      // positive frame shows either resumed work or an idle composer.
      replayAutomationClearance(active, reading.facts);
    } finally {
      readiness.observeReadinessFrame(reading.facts, active.trustInputBlocking);
    }
  };
  return {
    refresh,
    observe: (current: RenderedFrame) => {
      frame = current;
      refresh();
    },
    /**
     * Blocking evidence is ignored while `starting`, yet that frame already spent the
     * attention edge. Once live, block on a still-visible gate AND announce it, so a
     * startup gate never yields `blocked` without its human-decision activity (C-ATTN-03).
     */
    blockOnceLive: (active: FrameSession) => {
      if (active.inputBlocking && active.submitEvidence("blocking_prompt_shown").to === "blocked")
        observers.emitActivity(
          activityFromAttention(observers.agent, observers.elwoodSessionId, ruleIds),
        );
    },
  };
}

/** Cancel automation synchronously before signaling or disposing its PTY. */
export function bindStartupLifetime(
  session: Pick<SessionLifecycle, "closing" | "bindInitialReadinessHold">,
  trust: TrustState,
  readiness: ReadinessGate,
): void {
  session.bindInitialReadinessHold(readiness.isHeld);
  session.closing.signal.addEventListener(
    "abort",
    () => {
      trust.dispose();
      readiness.ready.cancel();
    },
    { once: true },
  );
}
