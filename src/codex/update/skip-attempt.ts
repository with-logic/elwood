/** Reconcile a bounded update attempt with its owning appearance (PRD §5.5, C-CODEX-12/27). */
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { writeCodexUpdateSkip } from "../update-prompt.ts";
import { updateScreenBanner } from "./recognition.ts";
import { codexDialogShown, codexRepaintComposerShown } from "./repaint.ts";
import { safeUpdateOption } from "./selection.ts";
import type { CodexUpdatePromptTracker } from "./tracker.ts";

/**
 * Codex drew its boot composer or resume placeholder within 8 ms of a skip in every run
 * measured, so a repaint that shows neither within this bound is not the skip's.
 */
export const repaintGraceMs = 2_000;
/** Codex's configured composer followed that repaint within 5 s in every run measured. */
export const repaintOwnershipMs = 30_000;

type UpdateSkipRequest = {
  readonly option: string;
  readonly generation: number;
  readonly screenText: string;
  readonly tracker: CodexUpdatePromptTracker;
  readonly writeAutomation: (input: string) => TrustWriteResult | Promise<AutomationWriteResult>;
  readonly readFrame: (() => string) | undefined;
  readonly signal: AbortSignal;
  readonly clearance: TrustClearance;
  readonly inputHeld: () => boolean;
  readonly releaseLatch: () => void;
  /** The ownership bound released Codex's repaint; the session reads its frame again. */
  readonly repaintReleased: () => void;
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
  let settled = false;
  let written = false;
  let cleared = false;
  // Codex's repaint after a fulfilled key: not reached, owned, or no longer owned.
  let repaint: "none" | "owned" | "released" = "none";
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const releaseRepaint = () => {
    clearTimeout(expiry);
    repaint = "released";
  };
  const finish = (result: StartupWriteCompletion) => {
    if (settled) return;
    settled = true;
    completion.resolve(result);
    retries.abort();
    if (result !== "answered") releaseRepaint();
  };
  const end = () => {
    finish("cancelled");
    releaseRepaint();
  };
  const bound = (ms: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      end();
      // No frame may follow: the session reads the current one without this hold.
      request.repaintReleased();
    }, ms);
    expiry.unref?.();
  };
  // The tracker counts a prompt left for an unclear frame as superseded; that frame is
  // this key's repaint, so ownership is taken while the attempt still owns its prompt.
  const own = () => {
    if (repaint !== "none" || !written || !ownsAttempt()) return;
    repaint = "owned";
    bound(repaintGraceMs);
  };
  /** A frame of Codex's repaint after this attempt's key (C-CODEX-27). */
  const observeRepaint = (frame: string) => {
    if (trustGateVisible(frame, "codex") || codexDialogShown(frame)) {
      end();
      return;
    }
    // Codex's own composer shows that it took the key: its boot composer or resume
    // placeholder, held until its configured composer, or the configured one itself.
    const configured = request.clearance(frame);
    if (!(configured || codexRepaintComposerShown(frame))) return;
    if (!(settled || configured)) bound(repaintOwnershipMs);
    finish("answered");
    if (configured) releaseRepaint();
  };
  signal.addEventListener("abort", end, { once: true });
  const answerIfCleared = () => {
    if (written && cleared && ownsAttempt()) finish("answered");
  };
  void writeCodexUpdateSkip(
    request.option,
    request.writeAutomation,
    readFrame,
    current,
    invalidated,
    retrySignal,
    request.clearance,
    () => {
      written = true;
      answerIfCleared();
    },
    (frame) => safeUpdateOption(frame, tracker.classify(frame).options),
  ).then(
    (result) => {
      // Codex's repaint settles an attempt that owns it (C-CODEX-27).
      if (settled || repaint === "owned") return;
      if (!ownsAttempt() || result === "exhausted" || result === "unobserved") {
        finish("cancelled");
        return;
      }
      if (result === "left") return own();
      if (result === "cancelled") releaseLatch();
      finish(result);
    },
    (error: unknown) => {
      // Disposal has already settled the attempt as cancelled.
      if (settled) return;
      const replaced = tracker.hasSupersedingGeneration(generation);
      if (!replaced) releaseLatch();
      // The live screen can clear before the next responder observation.
      if (!current(readFrame?.() ?? screenText)) return finish("cancelled");
      settled = true;
      completion.reject(error);
      retries.abort();
      releaseRepaint();
    },
  );
  return {
    settled: completion.promise,
    cancel: end,
    ownsRepaint: () => repaint === "owned",
    observeFrame(frame: string): void {
      if (!written || repaint === "released") return;
      // The prompt drawn again is a new appearance, never this key's repaint.
      if (updateScreenBanner.test(frame)) {
        if (repaint === "owned") end();
        return;
      }
      own();
      if (repaint === "owned") observeRepaint(frame);
    },
    observeClearance(frame: string): void {
      if (settled || readFrame === undefined || !ownsAttempt()) return;
      if (invalidated(frame) || !request.clearance(frame)) return;
      // Keep this attempt's native edge before queued input can repaint it. A
      // pending write still has to fulfill; withheld/rejected writes never answer.
      cleared = true;
      answerIfCleared();
    },
  };
}
