/** Reconcile a bounded update attempt with its owning appearance (PRD §5.5, C-CODEX-12). */
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { type CodexUpdatePromptTracker, writeCodexUpdateSkip } from "../update-prompt.ts";

type UpdateSkipRequest = {
  readonly option: string;
  readonly generation: number;
  readonly screenText: string;
  readonly tracker: CodexUpdatePromptTracker;
  readonly writeAutomation: (input: string) => TrustWriteResult | Promise<AutomationWriteResult>;
  readonly readFrame: (() => string) | undefined;
  readonly signal: AbortSignal;
  readonly clearance: TrustClearance;
  readonly releaseLatch: () => void;
};

export function startCodexUpdateSkip(request: UpdateSkipRequest): Promise<StartupWriteCompletion> {
  const { tracker, generation, readFrame, screenText, signal, releaseLatch } = request;
  const sameUpdate = tracker.currentFramePredicate();
  const current = (frame: string) =>
    !signal.aborted && sameUpdate(frame) && !trustGateVisible(frame, "codex");
  // Losing update eligibility is not clearance while a replacement still holds input.
  const invalidated = (frame: string) =>
    trustGateVisible(frame, "codex") || tracker.holdWithoutAppearance;
  return writeCodexUpdateSkip(
    request.option,
    request.writeAutomation,
    readFrame,
    current,
    invalidated,
    signal,
    request.clearance,
  ).then(
    (completion) => {
      const replaced = tracker.hasLaterAppearance(generation);
      if (signal.aborted || completion === "exhausted" || replaced) return "cancelled";
      if (completion === "cancelled") releaseLatch();
      return completion;
    },
    (error: unknown): StartupWriteCompletion => {
      if (signal.aborted) return "cancelled";
      const replaced = tracker.hasLaterAppearance(generation);
      if (!replaced) releaseLatch();
      // The live screen can clear before the next responder observation.
      if (!current(readFrame?.() ?? screenText)) return "cancelled";
      throw error;
    },
  );
}
