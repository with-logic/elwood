/**
 * The Codex update-skip WRITE path: the guarded automation writer, the settled-frame
 * option revalidation, and the bounded retry loop. Implements PRD §5.5 and C-CODEX-12.
 *
 * Frame recognition lives in `recognition.ts` and the cross-frame appearance lifecycle in
 * `tracker.ts`; both are re-exported here so this file remains the single import site
 * for the update prompt.
 */

import type { InputTerminal } from "../../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { numberedOptions } from "../../core/terminal-options.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { codexUpdateChoiceIdentity, settledFrameKeepsChoice } from "./identity.ts";
import {
  codexUpdateOptionPattern,
  codexUpdatePromptVisible,
  hasContinuationShape,
  safeUpdateOption,
} from "./recognition.ts";

/** Recognition and lifecycle, re-exported so this stays the update entry point. */
export {
  codexUpdateOptionPattern,
  codexUpdatePromptVisible,
  safeUpdateOption,
  updateScreenBanner,
} from "./recognition.ts";
export { CodexUpdatePromptTracker } from "./tracker.ts";

const retryIntervalMs = 250;
const retryTimeoutMs = 5_000;

/** The Codex non-trust automation barrier, with update-option revalidation bound in. */
export function guardedCodexAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
): (input: string, perWrite?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  // The generation-aware predicate is supplied PER WRITE by `writeCodexUpdateSkip`, so an
  // older attempt can never validate against a newer appearance's state (#42 round 3).
  return guardedNonTrustAutomationWrite(terminal, write, readFrame, "codex", codexOptionStillSafe);
}

/**
 * Revalidates an update-skip key's SHAPE against the settled frame. The option number was
 * read from a pre-settle frame, so a replacement or renumbered update screen can move the
 * safe choice; sending the old number would select whatever now sits at that position.
 * Keys that are not update-screen option numbers (other automation) are left alone.
 *
 * This is HALF the guard, not the whole one: it proves the settled frame still offers this
 * number as a safe option on an update-shaped screen, never that the screen is the one the
 * attempt started on. Always pair it with the caller's captured tracker predicate.
 */
export function codexOptionStillSafe(frameText: string, input: string): boolean {
  if (!/^\d+$/.test(input)) return true;
  const options = numberedOptions(frameText);
  // Codex can repaint the safe choices WITHOUT the banner, so requiring a full update
  // screen here would withhold a correct key (C-CODEX-12). The question is narrower:
  // on the settled frame, does this number still name a safe option? If the frame shows
  // no numbered options at all it has moved on entirely, and the key is stale.
  if (options.length === 0) return false;
  // The number must name a safe option AND the frame must still be update-SHAPED: either
  // the first-party screen, or the safe-choice-only repaint Codex draws mid-flow.
  //
  // Shape is ALL this checks. It does not establish that the frame belongs to the
  // appearance the key was chosen for — an unrelated prompt offering a "Skip" has the
  // same shape. Appearance identity comes from the tracker predicate the caller passes
  // as `perWrite`, and BOTH must hold before a key goes out (C-CODEX-22).
  if (!(codexUpdatePromptVisible(frameText) || hasContinuationShape(frameText))) return false;
  return options.some(
    (option) => option.number === input && codexUpdateOptionPattern.test(option.label),
  );
}

/** `exhausted`: the retry budget ended while the safe option was still visible. */
export type CodexUpdateSkipCompletion = StartupWriteCompletion | "exhausted";

/**
 * Retries a possibly swallowed startup hotkey only while its safe option remains visible.
 *
 * `answered` means the update screen CLEARED after our key. A frame that merely stops
 * being the update screen is not clearance: when `invalidated` recognizes it (a trust
 * gate painted over the update screen), the skip is reported `cancelled` so no
 * `startup_prompt` success is emitted for an update that never took (C-CODEX-12).
 */
export async function writeCodexUpdateSkip(
  option: string,
  write: (
    input: string,
    perWrite?: (frameText: string) => boolean,
  ) => TrustWriteResult | Promise<AutomationWriteResult>,
  readFrame?: () => string,
  currentUpdateFrame: (frameText: string) => boolean = codexUpdatePromptVisible,
  invalidated: (frameText: string) => boolean = () => false,
): Promise<CodexUpdateSkipCompletion> {
  if (readFrame === undefined) {
    // A guarded writer can still withhold (its own settled-frame checks apply), and a
    // key nobody sent is not an answer even with no reader to retry from.
    return (await write(option, currentUpdateFrame)) === "withheld" ? "cancelled" : "answered";
  }
  const deadline = Date.now() + retryTimeoutMs;
  let wrote = false;
  while (Date.now() < deadline) {
    const frame = readFrame();
    if (!currentUpdateFrame(frame)) {
      const cleared = wrote && !invalidated(frame);
      return cleared ? "answered" : "cancelled";
    }
    const safeOption = safeUpdateOption(frame);
    if (safeOption === undefined) return "cancelled";
    // A guarded writer settles rendering before the key goes out, so it may report the
    // key WITHHELD (a trust gate, or this option number no longer the safe one on the
    // settled frame). That is not an answer: leave the screen unanswered for a human
    // rather than counting a key nobody sent (C-CODEX-12, C-TRUST-01).
    // Bind the write to the identity captured HERE: the same generation predicate AND
    // the exact dialog/option this attempt decided on. The settled frame must still be
    // that one, so a later generation, a renumbered dialog, a replacement dialog, or an
    // unrelated prompt offering a "Skip" all fail the guard rather than take this key.
    const identity = codexUpdateChoiceIdentity(frame, safeOption);
    const stillThisChoice = (settledFrame: string): boolean =>
      settledFrameKeepsChoice(settledFrame, identity, safeOption.number, currentUpdateFrame);
    if ((await write(safeOption.number, stillThisChoice)) === "withheld") return "cancelled";
    wrote = true;
    await wait(retryIntervalMs);
  }
  return "exhausted";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
