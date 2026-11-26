/**
 * Session-owned frame and trust-deadline observation, and the block on an unrecognized
 * startup screen (PRD §5.3/§5.4, C-TRUST-01, C-API-72, C-ATTN-11).
 */
import { activityFromAttention, blockingRuleIds } from "../../core/attention.ts";
import { runEach } from "../../core/contained.ts";
import {
  observeRenderedReading,
  type RenderedObservers,
  readRenderedFrame,
  withBlockingRule,
} from "../../core/rendered-observers.ts";
import type { RenderedFrame, ScreenFacts } from "../../core/screen-facts.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { createFrameObserverFailureReporter } from "../../core/warnings/frames.ts";
import type { SessionWarningSink } from "../../core/warnings/session.ts";
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

/**
 * Timers and PTY frames use the same guards, facts, and attention edge owner. A frame whose
 * notifications failed is reported to `observers.warnings`, the session's startup warning
 * gate (C-API-14, C-API-72).
 */
export function createSessionFrameObserver(
  observers: RenderedObservers & { readonly warnings: SessionWarningSink },
  session: () => FrameSession | undefined,
  trust: () => StartupAutomationState,
  readiness: ReadinessGate,
  isIdleComposer: TrustClearance,
) {
  const reportFailure = createFrameObserverFailureReporter(
    observers.warnings,
    observers,
    () => session()?.closing.signal.aborted === false,
  );
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
  const refreshUncontained = () => {
    const active = session();
    const current = frame;
    if (active === undefined || active.closing.signal.aborted || current === undefined) return;
    const state = trust();
    const rendered = readRenderedFrame(
      observers,
      current,
      state.blockedPrompt,
      state.inputBlocking,
    );
    const unrecognized = readiness.unrecognizedStartup.classify(
      rendered.facts,
      state.inputBlocking,
      current,
    );
    const reading = attentionClearance(
      unrecognized
        ? withBlockingRule(rendered, `${observers.agent}-unrecognized-startup`)
        : rendered,
      current.text,
      state.inputBlocking,
    );
    const released = active.automationInputBlocking && !state.inputBlocking;
    active.automationInputBlocking = state.inputBlocking;
    active.inputBlocking =
      reading.facts.blocking_prompt_visible ||
      (active.inputBlocking && !reading.facts.working_visible && !reading.facts.composer_visible);
    const currentRuleIds = blockingRuleIds(reading);
    if (currentRuleIds.length > 0 || !active.inputBlocking) ruleIds = currentRuleIds;
    if (released && active.status === "blocked") pendingAutomationClearance = true;
    // Settle automation against this frame before evidence/readiness releases input.
    state.observeClearance?.(current.text);
    // Publish this frame's hold before evidence listeners can submit readiness.
    readiness.observeFrameHold(
      reading.facts,
      active.automationInputBlocking,
      current.text,
      current.cols,
    );
    readiness.ready.armDeadline();
    runEach(
      () => observeRenderedReading(observers, reading, active),
      // Automation can consume the human clear edge. Retain its replay until a
      // positive frame shows either resumed work or an idle composer.
      () => replayAutomationClearance(active, reading.facts),
      () => readiness.unrecognizedStartup.report(current.text),
      () =>
        readiness.observeReadinessFrame(
          reading.facts,
          active.automationInputBlocking,
          current.text,
          current.cols,
        ),
    );
  };
  // A throwing listener cannot escape into the render loop or a timer, and cannot drop the
  // frame's other notifications or its `terminal:data`. Its failure is reported (C-API-72).
  const refresh = () => {
    try {
      refreshUncontained();
    } catch {
      reportFailure();
    }
  };
  // At the deadline, or when an adapter's evidence changes with time (Codex's effort wait), an
  // idle CLI does not repaint, so its current frame is classified again.
  readiness.setDeadlineListener((settled) => {
    if (frame !== undefined && settled !== undefined) frame = { ...frame, ...settled };
    refresh();
  });
  return {
    refresh,
    /** Frame processing outside `refresh`, such as update discovery after a skip, reports here. */
    reportFailure,
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
