/** Recognizes native update appearances and continuation rows (PRD §5.5, C-CODEX-12). */
import { nonOptionText, numberedOptions } from "../../core/terminal-options.ts";
import { codexUpdateActionPattern, codexUpdateOptionPattern } from "./selection.ts";

/** The first-party banner; its version pair distinguishes one appearance from the next. */
export const updateScreenBanner =
  /^[^\S\r\n]*(?:Update available!\s+\d+\.\d+\.\d+\s*(?:->|→)\s*\d+\.\d+\.\d+|A new version of Codex is available[.!]?)[^\S\r\n]*$/im;

/**
 * A captured first-party banner alone counts so a partial layout fails safe
 * before its options paint. Generic "update available" prose does not count;
 * an option-only frame must carry both the update and safe choices.
 */
export function codexUpdatePromptVisible(frameText: string): boolean {
  if (updateScreenBanner.test(frameText)) return true;
  const options = numberedOptions(frameText);
  return (
    options.some((option) => codexUpdateActionPattern.test(option.label)) &&
    options.some((option) => codexUpdateOptionPattern.test(option.label))
  );
}

export function isSafeUpdateContinuation(frameText: string): boolean {
  if (nonOptionText(frameText).trim() !== "") return false;
  return numberedOptions(frameText).some((option) =>
    /continue\s*without\s*updat|skip/i.test(option.label),
  );
}
