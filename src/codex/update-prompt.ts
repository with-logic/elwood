/**
 * Orchestrates guarded Codex update-skip writes and bounded retries (PRD §5.5, C-CODEX-12).
 * Active classification lives in update/classification.ts and update/layout.ts;
 * update/recognition.ts is the visibility facade.
 */

import { type InputTerminal, waitForInput } from "../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../core/startup/write.ts";
import type { NumberedOption } from "../core/terminal-options.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import type { TrustWriteResult } from "../core/trust/responder.ts";
import { codexComposerClearance } from "./screen/clearance.ts";
import { classifyCodexUpdateFrame } from "./update/classification.ts";
import { updateScreenBanner } from "./update/recognition.ts";
import { codexUpdateOptionPattern, safeUpdateOption } from "./update/selection.ts";
import { codexUpdateChoiceIdentity, settledFrameKeepsChoice } from "./update-identity.ts";

const retryIntervalMs = 250;
const retryTimeoutMs = 5_000;
/**
 * Codex drops a key that arrives while it paints its update prompt: a key 1 ms after Codex
 * 0.172 drew the prompt was dropped in 5 of 5 runs, and one 252 ms after it was taken in 5
 * of 5 (docs/cli-behavior.md, "Codex update skip keys").
 */
export const firstKeyDelayMs = 500;

/**
 * The Codex non-trust automation barrier, with update-option revalidation bound in. Its
 * first key waits until `firstKeyDelayMs` after the writer was made, so the session makes
 * one per rendered frame, and an update skip keeps the one from the frame it starts on.
 */
export function guardedCodexAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  signal?: AbortSignal,
): (input: string, perWrite?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  const frameRenderedAt = Date.now();
  // The generation-aware predicate is supplied PER WRITE by `writeCodexUpdateSkip`, so an
  // older attempt can never validate against a newer appearance's state (#42 round 3).
  const guarded = guardedNonTrustAutomationWrite(
    terminal,
    write,
    readFrame,
    "codex",
    codexOptionStillSafe,
    () => signal?.aborted ?? false,
    signal,
  );
  return async (input, perWrite) => {
    const wait = frameRenderedAt + firstKeyDelayMs - Date.now();
    // A close during the wait is reported by the guarded write below as withheld.
    if (wait > 0) await waitForInput(wait, signal).catch(() => undefined);
    return guarded(input, perWrite);
  };
}

/**
 * Revalidates an update-skip key against the SETTLED frame. The option number was read
 * from a pre-settle frame, so a replacement or renumbered update screen can move the safe
 * choice; sending the old number would select whatever now sits at that position. Keys
 * that are not update-screen option numbers (other automation) are left alone.
 */
export function codexOptionStillSafe(frameText: string, input: string): boolean {
  if (!/^\d+$/.test(input)) return true;
  const frame = classifyCodexUpdateFrame(frameText);
  const options = frame.options ?? [];
  // The current first-party banner is required even when old option bindings match.
  // Bannerless choices remain input-blocking evidence, never write authorization.
  if (!frame.hasBanner || options.length === 0) return false;
  return options.some(
    (option) => option.number === input && codexUpdateOptionPattern.test(option.label),
  );
}

/**
 * Writes the safe choice read from `frame`, and resolves to the frame the key met, or to
 * undefined when it was withheld. A guarded writer settles rendering before the key goes
 * out, so it may report the key WITHHELD (a trust gate, or this option number no longer the
 * safe one on the settled frame). That is not an answer: leave the screen unanswered for a
 * human rather than counting a key nobody sent (C-CODEX-12, C-TRUST-01). The write is bound
 * to the identity captured from `frame`: the same generation predicate AND the exact
 * dialog/option this attempt decided on. The settled frame must still be that one, so a
 * later generation, a renumbered dialog, a replacement dialog, or an unrelated prompt
 * offering a "Skip" all fail the guard rather than take this key.
 */
async function writeChoice(
  write: (
    input: string,
    perWrite?: (frameText: string) => boolean,
  ) => TrustWriteResult | Promise<AutomationWriteResult>,
  eligible: (frameText: string) => boolean,
  frame: string,
  choice: NumberedOption,
): Promise<string | undefined> {
  const identity = codexUpdateChoiceIdentity(frame, choice);
  // A guarded writer reads the settled frame the key meets; a direct one writes onto `frame`.
  let keyFrame = frame;
  const stillThisChoice = (settledFrame: string): boolean => {
    keyFrame = settledFrame;
    return settledFrameKeepsChoice(settledFrame, identity, choice.number, eligible);
  };
  return (await write(choice.number, stillThisChoice)) === "withheld" ? undefined : keyFrame;
}

/**
 * `exhausted`: the retry budget ended while the safe option was still visible. `left`: the
 * prompt left after a fulfilled key, for a frame that does not yet clear it; the attempt
 * reads the frames that follow (C-CODEX-27).
 */
export type CodexUpdateSkipCompletion =
  | StartupWriteCompletion
  | "exhausted"
  | "unobserved"
  | "left";

/**
 * Writes the safe choice, and again only when a later frame still shows the prompt
 * (docs/cli-behavior.md, "Codex update skip keys"). The writer from
 * `guardedCodexAutomationWrite` holds the first key until the prompt has been on screen
 * for `firstKeyDelayMs`, since Codex drops a key that arrives while it paints the prompt.
 * A frame unchanged since a key cannot show that Codex ignored it: Codex can take the key
 * and draw its next screen before Elwood renders, so a key retyped then reaches that screen.
 *
 * `answered` requires a fulfilled physical write and positive native composer
 * clearance with no invalidating session input hold. Missing readers cannot prove
 * success; an unobserved fulfilled write remains latched so persistent frames cannot
 * start another skip (C-CODEX-12/17).
 */
export async function writeCodexUpdateSkip(
  option: string,
  write: (
    input: string,
    perWrite?: (frameText: string) => boolean,
  ) => TrustWriteResult | Promise<AutomationWriteResult>,
  readFrame?: () => string,
  currentUpdateFrame: (frameText: string) => boolean = (frame) => updateScreenBanner.test(frame),
  invalidated: (frameText: string) => boolean = () => false,
  signal?: AbortSignal,
  clearance: TrustClearance = codexComposerClearance,
  onWritten?: () => void,
  selectOption: typeof safeUpdateOption = safeUpdateOption,
): Promise<CodexUpdateSkipCompletion> {
  const eligible = (frame: string) => updateScreenBanner.test(frame) && currentUpdateFrame(frame);
  if (readFrame === undefined) {
    // A fulfilled write alone cannot prove the dialog cleared.
    return (await write(option, eligible)) === "withheld" ? "cancelled" : "unobserved";
  }
  const completionAfterPromptLeft = (frame: string) =>
    clearance(frame) && !invalidated(frame) ? "answered" : "left";
  const deadline = Date.now() + retryTimeoutMs;
  // The settled frame the last key went out on; undefined until one has.
  let lastKeyFrame: string | undefined;
  while (Date.now() < deadline) {
    const frame = readFrame();
    if (!eligible(frame))
      return lastKeyFrame === undefined ? "cancelled" : completionAfterPromptLeft(frame);
    if (frame !== lastKeyFrame) {
      const safeOption = selectOption(frame);
      if (safeOption === undefined) return "cancelled";
      const keyFrame = await writeChoice(write, eligible, frame, safeOption);
      if (keyFrame !== undefined) {
        lastKeyFrame = keyFrame;
        onWritten?.();
      } else if (lastKeyFrame === undefined) {
        // A key withheld before any went out ends the attempt. A withheld retype follows
        // a key that may have landed, so the next frame decides.
        return "cancelled";
      }
    }
    await waitForInput(retryIntervalMs, signal);
  }
  return "exhausted";
}
