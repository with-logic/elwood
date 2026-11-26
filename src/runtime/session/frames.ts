/**
 * Session-owned frame and trust-deadline observation, and the block on an unrecognized
 * startup screen (PRD §5.3/§5.4, C-TRUST-01, C-ATTN-11).
 */
import { activityFromAttention, blockingRuleIds } from "../../core/attention.ts";
import { runContained } from "../../core/contained.ts";
import {
  observeRenderedReading,
  type RenderedObservers,
  readRenderedFrame,
  withBlockingRule,
} from "../../core/rendered-observers.ts";
import type { RenderedFrame, ScreenFacts } from "../../core/screen-facts.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { createAttentionClearance } from "./attention-clearance.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { ReadinessGate } from "./readiness.ts";
import { onCallerInput } from "./session-input.ts";

type FrameSession = Pick<
  SessionLifecycle,
  "closing" | "inputBlocking" | "automationInputBlocking" | "submitEvidence" | "status"
>;

/** The startup prompt responder: trust automation and Codex's update-skip repaint (C-CODEX-27). */
type StartupAutomationState = {
  readonly inputBlocking: boolean;
  readonly blockedPrompt: string | undefined;
  dispose(): void;
  observeClearance?(frame: string): void;
};

/** Timers and PTY frames use the same guards, facts, and attention edge owner. */
export function createSessionFrameObserver(
  observers: RenderedObservers,
  session: () => FrameSession | undefined,
  trust: () => StartupAutomationState,
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
      !active.automationInputBlocking &&
      !active.inputBlocking &&
      (facts.working_visible || facts.composer_visible)
    ) {
      if (facts.working_visible) observers.turn.adoptWorkingClearance(facts);
      active.submitEvidence("blocking_prompt_cleared", facts.working_visible);
    }
    if (active.status !== "blocked") pendingAutomationClearance = false;
  };
  const refreshFrame = () => {
    const active = session();
    if (active === undefined || active.closing.signal.aborted || frame === undefined) return;
    const state = trust();
    const baseReading = readRenderedFrame(
      observers,
      frame,
      state.blockedPrompt,
      state.inputBlocking,
    );
    const unrecognized = readiness.unrecognizedStartup.classify(
      baseReading.facts,
      state.inputBlocking,
      frame,
    );
    // The rendered facts, then those facts after attention clearance.
    const clearedReading = attentionClearance(
      unrecognized
        ? withBlockingRule(baseReading, `${observers.agent}-unrecognized-startup`)
        : baseReading,
      frame.text,
      state.inputBlocking,
    );
    const released = active.automationInputBlocking && !state.inputBlocking;
    active.automationInputBlocking = state.inputBlocking;
    active.inputBlocking =
      clearedReading.facts.blocking_prompt_visible ||
      (active.inputBlocking &&
        !clearedReading.facts.working_visible &&
        !clearedReading.facts.composer_visible);
    const currentRuleIds = blockingRuleIds(clearedReading);
    if (currentRuleIds.length > 0 || !active.inputBlocking) ruleIds = currentRuleIds;
    if (released && active.status === "blocked") pendingAutomationClearance = true;
    // Settle automation against this frame before evidence/readiness releases input.
    state.observeClearance?.(frame.text);
    // Publish this frame's hold before evidence listeners can submit readiness.
    readiness.observeFrameHold(
      clearedReading.facts,
      active.automationInputBlocking,
      frame.text,
      frame.cols,
    );
    readiness.ready.armDeadline();
    try {
      observeRenderedReading(observers, clearedReading, active);
      // Automation can consume the human clear edge. Retain its replay until a
      // positive frame shows either resumed work or an idle composer.
      replayAutomationClearance(active, clearedReading.facts);
    } finally {
      // Reported even when a status or attention listener throws.
      readiness.unrecognizedStartup.report(frame.text);
      readiness.observeReadinessFrame(
        clearedReading.facts,
        active.automationInputBlocking,
        frame.text,
        frame.cols,
      );
    }
  };
  // A throwing status, attention or readiness listener cannot drop the frame: the session
  // finishes processing it, and its terminal data is still delivered (C-ATTN-11).
  const refresh = () => runContained(refreshFrame);
  readiness.setDeadlineListener((current) => {
    if (frame !== undefined && current !== undefined) frame = { ...frame, ...current };
    refresh();
  });
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

/**
 * Cancel automation synchronously before signaling or disposing its PTY, and hand the
 * startup prompt on screen to the caller as soon as raw caller input reaches the
 * session's terminal.
 */
export function bindStartupLifetime(
  session: Pick<SessionLifecycle, "closing" | "bindInitialReadinessHold" | "terminal">,
  trust: StartupAutomationState & { callerInput(): void },
  readiness: ReadinessGate,
): void {
  // Bound synchronously after the terminal attaches, before PTY output can arrive.
  readiness.bindTerminal(session.terminal);
  session.bindInitialReadinessHold(readiness);
  const stopCallerInput = onCallerInput(session.terminal, () => trust.callerInput());
  session.closing.signal.addEventListener(
    "abort",
    () => {
      stopCallerInput();
      trust.dispose();
      readiness.ready.cancel();
    },
    { once: true },
  );
}
