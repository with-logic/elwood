/** Reconcile a bounded update attempt with its owning appearance (PRD §5.5, C-CODEX-12/27). */
import { runContained } from "../../core/contained.ts";
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { writeCodexUpdateSkip } from "../update-prompt.ts";
import { updateScreenBanner } from "./recognition.ts";
import { codexDialogVisible, codexUnconfiguredComposerVisible } from "./repaint.ts";
import { safeUpdateOption } from "./selection.ts";
import type { CodexUpdatePromptTracker } from "./tracker.ts";

/**
 * Codex drew its boot composer or resume placeholder within 8 ms of a skip in every run
 * measured, so a repaint that shows neither within this bound is not the skip's.
 */
export const repaintGraceMs = 2_000;
/** Codex's configured composer followed that repaint within 5 s in every run measured. */
export const answeredRepaintBoundMs = 30_000;

type UpdateSkipRequest = {
  readonly option: string;
  readonly generation: number;
  readonly screenText: string;
  readonly tracker: CodexUpdatePromptTracker;
  readonly writeAutomation: (
    input: string,
    perWrite?: (frameText: string) => boolean,
  ) => TrustWriteResult | Promise<AutomationWriteResult>;
  readonly readFrame: (() => string) | undefined;
  readonly signal: AbortSignal;
  readonly clearance: TrustClearance;
  /** The session's input hold, which includes this attempt's own repaint hold. */
  readonly inputHeld: () => boolean;
  readonly releaseLatch: () => void;
  /** A grace or answered bound expired with no frame to follow; the session reads its frame again. */
  readonly repaintExpired: () => void;
};

type UpdateSkipAttempt = {
  readonly settled: Promise<StartupWriteCompletion>;
  readonly observeClearance: (frame: string) => void;
  /** Each frame the session renders, before its input hold is classified. */
  readonly observeFrame: (frame: string) => void;
  /** Codex is repainting after this attempt's key: input stays held, and no dialog is reported. */
  readonly ownsRepaint: () => boolean;
  /** Raw caller input owns this appearance: no retry or pending write follows it. */
  readonly cancel: () => void;
};

export function startCodexUpdateSkip(request: UpdateSkipRequest): UpdateSkipAttempt {
  const { tracker, generation, readFrame, screenText, signal, releaseLatch } = request;
  const completion = Promise.withResolvers<StartupWriteCompletion>();
  const retries = new AbortController();
  const retrySignal = AbortSignal.any([signal, retries.signal]);
  const sameUpdate = tracker.currentFramePredicate();
  const current = (frame: string) =>
    !retrySignal.aborted && sameUpdate(frame) && !trustGateVisible(frame, "codex");
  const invalidated = (frame: string) => trustGateVisible(frame, "codex") || request.inputHeld();
  const ownsAttempt = () => !(signal.aborted || tracker.hasSupersedingGeneration(generation));
  const settled = () => retries.signal.aborted;
  let written = false;
  let cleared = false;
  // Codex's repaint after a fulfilled key: not reached, owned, or no longer owned.
  let repaint: "none" | "owned" | "released" = "none";
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const releaseRepaint = () => {
    clearTimeout(expiry);
    repaint = "released";
  };
  // PTY frames the session rendered during this attempt, and their count at its last key.
  let framesDrawn = 0;
  let framesAtKey: number | undefined;
  /** Settles once. Only an answer keeps the repaint, which Codex is still drawing. */
  const finish = (result: StartupWriteCompletion) => {
    if (settled()) return;
    completion.resolve(result);
    retries.abort();
    if (result !== "answered") releaseRepaint();
  };
  /** Ends the attempt and its repaint hold, even after an answer. */
  const cancelAndReleaseRepaint = () => {
    finish("cancelled");
    releaseRepaint();
  };
  const expireRepaintAfter = (ms: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      cancelAndReleaseRepaint();
      // No frame may follow: the session reads the current one without this hold.
      runContained(request.repaintExpired);
    }, ms);
    expiry.unref?.();
  };
  // Called from `observeFrame`, which the responder runs before `observeClearance`. On a
  // frame that does not clear the prompt that call moves the tracker past this generation,
  // and `ownsAttempt()` is false from then on.
  const takeRepaint = () => {
    if (repaint !== "none" || !written || !ownsAttempt()) return;
    repaint = "owned";
    expireRepaintAfter(repaintGraceMs);
  };
  // A retype needs a frame Codex drew after the last key. A resize or host output changes
  // Elwood's frame without one, while Codex may already have taken the key.
  const writeOnNewFrame: UpdateSkipRequest["writeAutomation"] = (input, perWrite) =>
    framesAtKey === framesDrawn
      ? Promise.resolve<AutomationWriteResult>("withheld")
      : request.writeAutomation(input, perWrite);
  /** A frame of Codex's repaint after this attempt's key (C-CODEX-27). */
  const observeRepaint = (frame: string) => {
    if (trustGateVisible(frame, "codex") || codexDialogVisible(frame)) {
      cancelAndReleaseRepaint();
      return;
    }
    // Codex's own composer shows that it took the key: its boot composer or resume
    // placeholder, held until its configured composer, or the configured one itself.
    const configured = request.clearance(frame);
    if (!(configured || codexUnconfiguredComposerVisible(frame))) return;
    if (!(settled() || configured)) expireRepaintAfter(answeredRepaintBoundMs);
    finish("answered");
    if (configured) releaseRepaint();
  };
  signal.addEventListener("abort", cancelAndReleaseRepaint, { once: true });
  const answerIfCleared = () => {
    if (written && cleared && ownsAttempt()) finish("answered");
  };
  void writeCodexUpdateSkip(
    request.option,
    writeOnNewFrame,
    readFrame,
    current,
    invalidated,
    retrySignal,
    request.clearance,
    () => {
      framesAtKey = framesDrawn;
      written = true;
      answerIfCleared();
    },
    (frame) => safeUpdateOption(frame, tracker.classify(frame).options),
  ).then(
    (result) => {
      // Codex's repaint settles an attempt that owns it (C-CODEX-27).
      if (settled() || repaint === "owned") return;
      if (!ownsAttempt() || result === "exhausted" || result === "unobserved") {
        finish("cancelled");
        return;
      }
      if (result === "left") return takeRepaint();
      if (result === "cancelled") releaseLatch();
      finish(result);
    },
    (error: unknown) => {
      // The attempt has already settled (answered, cancelled, or disposed).
      if (settled()) return;
      const replaced = tracker.hasSupersedingGeneration(generation);
      if (!replaced) releaseLatch();
      // The live screen can clear before the next responder observation.
      if (!current(readFrame?.() ?? screenText)) return finish("cancelled");
      completion.reject(error);
      retries.abort();
      releaseRepaint();
    },
  );
  return {
    settled: completion.promise,
    cancel: cancelAndReleaseRepaint,
    ownsRepaint: () => repaint === "owned",
    observeFrame(frame: string): void {
      framesDrawn += 1;
      if (!written || repaint === "released") return;
      // The prompt drawn again is a new appearance, never this key's repaint.
      if (updateScreenBanner.test(frame)) {
        if (repaint === "owned") cancelAndReleaseRepaint();
        return;
      }
      takeRepaint();
      if (repaint === "owned") observeRepaint(frame);
    },
    observeClearance(frame: string): void {
      if (settled() || readFrame === undefined || !ownsAttempt()) return;
      if (invalidated(frame) || !request.clearance(frame)) return;
      // Keep this attempt's native edge before queued input can repaint it. A
      // pending write still has to fulfill; withheld/rejected writes never answer.
      cleared = true;
      answerIfCleared();
    },
  };
}
