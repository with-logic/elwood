/**
 * Recognizes first-party Codex in-TUI update screens and their safe options.
 * Implements PRD §5.5 and C-CODEX-12 for both prompt automation and input blocking.
 */

import { numberedOptions } from "../core/terminal-options.ts";

export const codexUpdateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;
const updateScreenBanner =
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
    options.some((option) => /update\s+now/i.test(option.label)) &&
    options.some((option) => codexUpdateOptionPattern.test(option.label))
  );
}

/** Keeps a split prompt blocking until a frame with no update evidence clears it. */
export class CodexUpdatePromptTracker {
  private active = false;

  observe(frameText: string): boolean {
    if (codexUpdatePromptVisible(frameText)) this.active = true;
    else if (!(this.active && hasSafeUpdateOption(frameText))) this.active = false;
    return this.active;
  }
}

function hasSafeUpdateOption(frameText: string): boolean {
  return numberedOptions(frameText).some((option) => codexUpdateOptionPattern.test(option.label));
}
