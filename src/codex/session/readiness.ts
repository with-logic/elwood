/**
 * Codex's initial-readiness gate. Its deadline needs the configured composer: Codex's native
 * status footer. When the session requests an effort Codex labels (`reasoningEffort`, else a
 * `configOverrides` entry), the footer counts only once its label is not `default`, or once
 * the wait for that label ends: 50 seconds after launch, or at the deadline, 10 seconds after
 * the first frame, when that is later. A deciding `configOverrides` entry whose effort Elwood
 * does not recognize holds no wait. It is reported once, as is missing evidence at the separate
 * 60-second backstop, as a content-free warning (PRD §5.3, §5.7, C-API-28).
 * Its header drawn alone, its boot composer, its resume placeholder and its footer before it
 * shows the requested effort are startup screens Codex draws before that composer, not
 * unrecognized ones (§5.4, C-ATTN-11).
 */
import { runContained } from "../../core/contained.ts";
import type { CodexReasoningEffort } from "../../core/reasoning-effort.ts";
import { defaultWaitTimeoutMs } from "../../core/session-wait.ts";
import { deadlineClock } from "../../core/timers.ts";
import type { InitialReadinessWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { createNativeBootFrameMatcher } from "../../runtime/readiness/boot-frame.ts";
import { initialDeadlineMs } from "../../runtime/readiness/initial-ready.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import {
  hasUnrecognizedDecidingCodexEffortOverride,
  requestedCodexEffort,
} from "../config/effort.ts";
import { codexReadinessEvidence } from "../screen/clearance.ts";
import { codexFooterShowsEffort } from "../screen/footer.ts";
import { codexUnconfiguredComposerVisible } from "../update/repaint.ts";
import type { CodexEventMap, StartCodexOptions } from "./types.ts";

/** Codex's header drawn alone while it loads (C-ATTN-11). */
export const isCodexBootFrame = createNativeBootFrameMatcher(/>_ OpenAI Codex \(v\d+\.\d+\.\d+/);

/** The launch facts the gate reads: a resume, the session id and the options that set an effort. */
export type CodexReadinessLaunch = {
  readonly resumed: boolean;
  readonly record: { readonly elwoodSessionId: string };
  readonly options: Pick<StartCodexOptions, "reasoningEffort" | "configOverrides">;
};

/** Room left for a render still in flight before a default host wait can expire. */
const hostWaitHeadroomMs = 10_000;

/**
 * How long after launch the wait for a requested effort's label lasts. A host can wait on a
 * session only once it exists, after launch, so a ready released then comes at least
 * `hostWaitHeadroomMs` before its default `waitForStatus` timeout can end. Readiness also
 * needs the deadline, `initialDeadlineMs` after the first frame, so that holds when Codex
 * drew its first frame within 40 seconds of launch (C-API-28).
 */
const codexEffortWaitFromLaunchMs = defaultWaitTimeoutMs - hostWaitHeadroomMs;

/** What the check reports as the wait for the effort's label ends. */
export type CodexEffortWaitEvents = {
  /** The wait ended: re-judge the current frame, since an idle Codex does not repaint. */
  readonly onWaitEnded: () => void;
  /** A `default` footer counted once the wait ended: the effort was never confirmed. */
  readonly onUnconfirmed: () => void;
};

/**
 * The configured-composer check for a session that requested `effort`. Make it at launch: the
 * wait's bound counts from this call, on the monotonic clock. Once a footer shows the effort,
 * Codex has applied its configuration: a later label, such as a pre-ready `setModel` to an
 * effort labelled `default`, cannot revoke that. The wait for the label ends
 * `codexEffortWaitFromLaunchMs` after launch, but never before the deadline, so a footer that
 * never shows it degrades to the footer alone and never holds readiness for good, and the
 * write hold and readiness release on it together.
 */
export function codexConfiguredCheck(
  effort: CodexReasoningEffort | undefined,
  { onWaitEnded, onUnconfirmed }: CodexEffortWaitEvents,
) {
  const launchedAtMs = deadlineClock.now();
  let lapse: ReturnType<typeof setTimeout> | undefined;
  let lapsed = false;
  let stopped = false;
  let waitOver = false;
  return {
    /**
     * Start the wait's bound with the shared deadline, on the first rendered frame, so only a
     * session that drew one holds the timer. It falls `codexEffortWaitFromLaunchMs` after
     * launch, or with the deadline when that frame comes more than 40 seconds after launch.
     */
    arm: () => {
      // Without an effort Codex labels, the footer counts as soon as it is drawn.
      if (stopped || !codexFooterShowsEffort(effort)) return;
      const remainingEffortWaitMs =
        launchedAtMs + codexEffortWaitFromLaunchMs - deadlineClock.now();
      lapse ??= setTimeout(
        () => {
          lapsed = true;
          runContained(onWaitEnded);
        },
        Math.max(initialDeadlineMs, remainingEffortWaitMs),
      );
    },
    stop: () => {
      stopped = true;
      clearTimeout(lapse);
    },
    configured: (frame: string, cols?: number): boolean => {
      const painted = codexReadinessEvidence(frame, cols);
      if (waitOver || !painted) return painted;
      if (codexReadinessEvidence(frame, cols, effort)) {
        waitOver = codexFooterShowsEffort(effort);
        return true;
      }
      if (!lapsed) return false;
      waitOver = true;
      runContained(onUnconfirmed);
      return true;
    },
  };
}

export function createCodexReadinessGate(
  onReady: () => void,
  { resumed, record, options }: CodexReadinessLaunch,
  warnings: { emitWarnings(warnings: readonly InitialReadinessWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
) {
  const { elwoodSessionId } = record;
  const emitEffortUnconfirmed = () =>
    warnings.emitWarnings([
      {
        elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_effort_unconfirmed",
        severity: "warning",
        message: `Codex did not show the requested reasoning effort within ${codexEffortWaitFromLaunchMs / 1_000} seconds of launch; readiness was released on its status footer, and a mode or model picked before Codex applies its configuration can be discarded.`,
        raw: "codex_effort_unconfirmed",
      },
    ]);
  const check = codexConfiguredCheck(requestedCodexEffort(options), {
    onUnconfirmed: emitEffortUnconfirmed,
    onWaitEnded: () => gate.rereadFrame(),
  });
  if (hasUnrecognizedDecidingCodexEffortOverride(options))
    warnings.emitWarnings([
      {
        elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_effort_unrecognized",
        severity: "warning",
        message:
          "Elwood did not recognize the reasoning effort that the last model_reasoning_effort entry in configOverrides sets. Codex receives it unchanged, but readiness does not wait for Codex to apply it, so a mode or model picked before then can be discarded.",
        raw: "codex_effort_unrecognized",
      },
    ]);
  const gate = createStartupReadinessGate(
    () => {
      onReady();
      check.stop();
    },
    resumed,
    {
      session: { agent: "codex", elwoodSessionId },
      configured: check.configured,
      // A footer still waiting for the requested effort is Codex's own, not unrecognized.
      nativeStartupScreen: (frame, cols) =>
        isCodexBootFrame(frame) ||
        codexUnconfiguredComposerVisible(frame) ||
        codexReadinessEvidence(frame, cols),
      warnings,
      events,
    },
  );
  const { ready } = gate;
  return {
    ...gate,
    ready: {
      ...ready,
      armDeadline: () => {
        check.arm();
        ready.armDeadline();
      },
      cancel: () => {
        check.stop();
        ready.cancel();
      },
    },
  };
}
