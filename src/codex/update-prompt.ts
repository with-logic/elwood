/**
 * Recognizes first-party Codex in-TUI update screens and their safe options.
 * Implements PRD §5.5 and C-CODEX-12 for both prompt automation and input blocking.
 */

import type { StartupWriteCompletion } from "../core/startup/write.ts";
import { nonOptionText, numberedOptions } from "../core/terminal-options.ts";
import type { TrustWriteResult } from "../core/trust/responder.ts";

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
  private generation = 0;

  /** Identifies the current appearance; it changes whenever the update screen clears or appears. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** True once a LATER appearance replaced `generation`; its own clear is only `generation + 1`. */
  hasLaterAppearance(generation: number): boolean {
    return this.generation > generation + 1;
  }

  observe(frameText: string): boolean {
    if (codexUpdatePromptVisible(frameText)) {
      if (!this.active) this.generation += 1;
      this.active = true;
    } else if (!(this.active && isSafeUpdateContinuation(frameText))) {
      if (this.active) this.generation += 1;
      this.active = false;
    }
    return this.active;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText));
  }
}

function isSafeUpdateContinuation(frameText: string): boolean {
  if (nonOptionText(frameText).trim() !== "") return false;
  return numberedOptions(frameText).some((option) =>
    /continue\s*without\s*updat|skip/i.test(option.label),
  );
}

const retryIntervalMs = 250;
const retryTimeoutMs = 5_000;

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
  write: (input: string) => TrustWriteResult,
  readFrame?: () => string,
  currentUpdateFrame: (frameText: string) => boolean = codexUpdatePromptVisible,
  invalidated: (frameText: string) => boolean = () => false,
): Promise<CodexUpdateSkipCompletion> {
  if (readFrame === undefined) {
    await write(option);
    return "answered";
  }
  const deadline = Date.now() + retryTimeoutMs;
  let wrote = false;
  while (Date.now() < deadline) {
    const frame = readFrame();
    if (!currentUpdateFrame(frame)) {
      const cleared = wrote && !invalidated(frame);
      return cleared ? "answered" : "cancelled";
    }
    const safeOption = numberedOptions(frame).find((candidate) =>
      codexUpdateOptionPattern.test(candidate.label),
    );
    if (safeOption === undefined) return "cancelled";
    await write(safeOption.number);
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
