/**
 * Recognizes first-party Codex in-TUI update screens and their safe options.
 * Implements PRD §5.5 and C-CODEX-12 for both prompt automation and input blocking.
 */

import { type InputTerminal, waitForInput } from "../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../core/startup/write.ts";
import { numberedOptions } from "../core/terminal-options.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import type { TrustWriteResult } from "../core/trust/responder.ts";
import { codexComposerClearance } from "./screen/clearance.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./update/recognition.ts";
import { codexUpdateOptionPattern, safeUpdateOption } from "./update/selection.ts";
import { codexUpdateChoiceIdentity, settledFrameKeepsChoice } from "./update-identity.ts";

export { codexUpdatePromptVisible, updateScreenBanner } from "./update/recognition.ts";
export { codexUpdateOptionPattern } from "./update/selection.ts";
export { CodexUpdatePromptTracker } from "./update/tracker.ts";

const retryIntervalMs = 250;
const retryTimeoutMs = 5_000;

/** The Codex non-trust automation barrier, with update-option revalidation bound in. */
export function guardedCodexAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  signal?: AbortSignal,
): (input: string, perWrite?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  // The generation-aware predicate is supplied PER WRITE by `writeCodexUpdateSkip`, so an
  // older attempt can never validate against a newer appearance's state (#42 round 3).
  return guardedNonTrustAutomationWrite(
    terminal,
    write,
    readFrame,
    "codex",
    codexOptionStillSafe,
    () => signal?.aborted ?? false,
    signal,
  );
}

/**
 * Revalidates an update-skip key against the SETTLED frame. The option number was read
 * from a pre-settle frame, so a replacement or renumbered update screen can move the safe
 * choice; sending the old number would select whatever now sits at that position. Keys
 * that are not update-screen option numbers (other automation) are left alone.
 */
export function codexOptionStillSafe(frameText: string, input: string): boolean {
  if (!/^\d+$/.test(input)) return true;
  const options = numberedOptions(frameText);
  // Codex can repaint the safe choices WITHOUT the banner, so requiring a full update
  // screen here would withhold a correct key (C-CODEX-12). The question is narrower:
  // on the settled frame, does this number still name a safe option? If the frame shows
  // no numbered options at all it has moved on entirely, and the key is stale.
  if (options.length === 0) return false;
  // The number must name a safe option AND the frame must still be update-shaped: either
  // the first-party screen, or the safe-choice-only repaint Codex draws mid-flow. An
  // unrelated human prompt that merely happens to carry a "Skip"/"Later" option is NOT
  // this dialog, and must stay for the human (#42 round 3, C-CODEX-12).
  if (!(codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText))) return false;
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
  signal?: AbortSignal,
  clearance: TrustClearance = codexComposerClearance,
): Promise<CodexUpdateSkipCompletion> {
  if (readFrame === undefined) {
    // A fulfilled write alone cannot prove the dialog cleared.
    await write(option, currentUpdateFrame);
    return "cancelled";
  }
  const deadline = Date.now() + retryTimeoutMs;
  let wrote = false;
  while (Date.now() < deadline) {
    const frame = readFrame();
    if (!currentUpdateFrame(frame)) {
      const cleared = wrote && clearance(frame) && !invalidated(frame);
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
    await waitForInput(retryIntervalMs, signal);
  }
  return "exhausted";
}
