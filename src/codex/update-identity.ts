/**
 * The identity an update-skip attempt captures, so a post-settlement check can prove the
 * settled frame is still the dialog it started on. Implements PRD §5.5 / C-CODEX-12 (#42).
 */

import { type NumberedOption, nonOptionText, numberedOptions } from "../core/terminal-options.ts";
import { updateScreenBanner } from "./update/recognition.ts";

/**
 * The identity of the update choice an attempt captured: the dialog's own non-option
 * text plus the exact option it decided to press (number AND label). Modelled on
 * `choiceIdentity` in the trust responder, for the same reason — a post-settlement check
 * must prove the frame is still the ONE the attempt started on, not merely that it looks
 * similar. Nothing outside this tuple can satisfy the guard: a new generation repaints
 * different non-option text, a renumbered dialog changes the number, a replacement
 * dialog changes the label, and an unrelated prompt changes all three (#42).
 */
export function codexUpdateChoiceIdentity(frameText: string, option: NumberedOption): string {
  // The banner carries the version pair, which is what distinguishes one appearance of
  // the update screen from the next; `nonOptionText` alone can be empty when the caret
  // row is parsed as an option, which would make two generations look identical.
  const banner = updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "";
  const labels = numberedOptions(frameText)
    .map((candidate) => `${candidate.number}:${candidate.label}`)
    .join("|");
  return JSON.stringify([
    nonOptionText(frameText).trim(),
    banner,
    labels,
    option.number,
    option.label,
  ]);
}

/**
 * The post-settlement guard an attempt binds to its key: the settled frame must still be
 * the dialog the attempt captured. Named and exported rather than an inline closure so
 * every branch is directly testable — `stillThisUpdate` carries the generation check,
 * and the identity comparison carries the dialog and option.
 */
export function settledFrameKeepsChoice(
  settledFrame: string,
  capturedIdentity: string,
  optionNumber: string,
  stillThisUpdate: (frameText: string) => boolean,
): boolean {
  if (!stillThisUpdate(settledFrame)) return false;
  const settledOption = numberedOptions(settledFrame).find(
    (candidate) => candidate.number === optionNumber,
  );
  if (settledOption === undefined) return false;
  return codexUpdateChoiceIdentity(settledFrame, settledOption) === capturedIdentity;
}
