/**
 * Runs ONE bounded Codex update-skip attempt per update-screen appearance and reconciles
 * its completion with the generation that owns it. Implements PRD §5.5 and C-CODEX-12.
 *
 * Extracted from `../startup-prompts.ts` verbatim so the startup responder keeps only prompt
 * dispatch; every rule here (optimistic latching, trust-gate ineligibility, invalidation,
 * supersession) is the behavior that file already had.
 */

import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { type CodexUpdatePromptTracker, writeCodexUpdateSkip } from "./index.ts";

/** The non-trust automation writer the skip and its retries go out through. */
export type CodexAutomationWriter = (
  input: string,
  perWrite?: (frameText: string) => boolean,
) => TrustWriteResult | Promise<AutomationWriteResult>;

/** What the caller needs to start an attempt and to release the latch afterwards. */
export type CodexUpdateSkipRequest = {
  readonly option: string;
  readonly generation: number;
  readonly screenText: string;
  readonly tracker: CodexUpdatePromptTracker;
  readonly writeAutomation: CodexAutomationWriter;
  readonly readFrame?: (() => string) | undefined;
  /** Clears the caller's latch so its own appearance can re-attempt the skip. */
  readonly releaseLatch: () => void;
};

/**
 * Starts the attempt and returns its settlement. A trust gate painted over the update
 * screen INVALIDATES the skip: the update never cleared, so it must not settle as
 * answered (C-CODEX-12, C-TRUST-01). A later appearance owns both the latch and the
 * settlement, so a superseded attempt settles as a quiet cancellation.
 */
export function startCodexUpdateSkip(
  request: CodexUpdateSkipRequest,
): Promise<StartupWriteCompletion> {
  const { generation, readFrame, releaseLatch, screenText, tracker } = request;
  const noTrustGate = (frame: string) => !trustGateVisible(frame, "codex");
  const sameUpdate = tracker.currentFramePredicate();
  const current = (frame: string) => sameUpdate(frame) && noTrustGate(frame);
  // A frame that merely stops being THIS update screen is not clearance. Clearance means
  // the screen went away; a trust gate painted over it, or a replacement dialog that ended
  // the appearance, means it never did. Reporting `answered` there is a FALSE SUCCESS: it
  // cancels the CLI's bounded update grace while the retained input hold keeps the session
  // blocked, so a headless run stalls without ever emitting `blocked_prompt` (#59 round 4).
  const invalidated = (frame: string) =>
    trustGateVisible(frame, "codex") || tracker.holdWithoutAppearance;
  return writeCodexUpdateSkip(
    request.option,
    request.writeAutomation,
    readFrame,
    current,
    invalidated,
  ).then(
    (completion) => {
      const replaced = tracker.hasLaterAppearance(generation);
      if (completion === "exhausted" || replaced) return "cancelled";
      if (completion === "cancelled") releaseLatch();
      return completion;
    },
    (error: unknown): StartupWriteCompletion => {
      const replaced = tracker.hasLaterAppearance(generation);
      if (!replaced) releaseLatch(); // retryable within its own appearance
      // The LIVE frame can clear before handle() sees it; with no reader, the
      // attempt's own frame reduces this to the generation check.
      if (!current(readFrame?.() ?? screenText)) return "cancelled";
      throw error;
    },
  );
}

/**
 * Whether the TRUST policy permits update-skip automation on this frame — i.e. no trust
 * gate is visible, whatever its rows say. This is only the trust precondition: it says
 * nothing about whether an update appearance is active or a safe option exists, so it is
 * never a sufficient write guard on its own (#59 round 3).
 */
export function codexUpdateSkipAllowedByTrust(screenText: string): boolean {
  return !trustGateVisible(screenText, "codex");
}
