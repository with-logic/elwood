/** Reconcile a bounded update attempt with its owning appearance (PRD §5.5, C-CODEX-12). */
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { writeCodexUpdateSkip } from "../update-prompt.ts";
import type { CodexUpdatePromptTracker } from "./tracker.ts";

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
};

type UpdateSkipAttempt = {
  readonly settled: Promise<StartupWriteCompletion>;
  readonly observeClearance: (frame: string) => void;
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
  const ownsAttempt = () => !(signal.aborted || tracker.hasLaterAppearance(generation));
  let written = false;
  let cleared = false;
  const finish = (result: StartupWriteCompletion) => {
    completion.resolve(result);
    retries.abort();
  };
  const answerIfCleared = () => {
    if (!retries.signal.aborted && written && cleared && ownsAttempt()) finish("answered");
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
  ).then(
    (result) => {
      if (retries.signal.aborted) return;
      if (!ownsAttempt() || result === "exhausted" || result === "unobserved") {
        finish("cancelled");
        return;
      }
      if (result === "cancelled") releaseLatch();
      finish(result);
    },
    (error: unknown) => {
      if (retries.signal.aborted) return;
      if (signal.aborted) return finish("cancelled");
      const replaced = tracker.hasLaterAppearance(generation);
      if (!replaced) releaseLatch();
      // The live screen can clear before the next responder observation.
      if (!current(readFrame?.() ?? screenText)) return finish("cancelled");
      completion.reject(error);
      retries.abort();
    },
  );
  return {
    settled: completion.promise,
    observeClearance(frame: string): void {
      if (retries.signal.aborted || readFrame === undefined || !ownsAttempt()) return;
      if (invalidated(frame) || !request.clearance(frame)) return;
      // Keep this attempt's native edge before queued input can repaint it. A
      // pending write still has to fulfill; withheld/rejected writes never answer.
      cleared = true;
      answerIfCleared();
    },
  };
}
