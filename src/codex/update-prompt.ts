/**
 * Recognizes first-party Codex in-TUI update screens and their safe options.
 * Implements PRD §5.5 and C-CODEX-12 for both prompt automation and input blocking.
 */

import type { InputTerminal } from "../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../core/startup/barrier.ts";
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

/** The Codex non-trust automation barrier, with update-option revalidation bound in. */
export function guardedCodexAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  /**
   * The generation-aware update predicate for the attempt in flight, read at write time
   * so the CURRENT attempt's predicate is used. A replacement dialog can reuse the same
   * option number for an unrelated human decision, so the option label alone is not
   * enough: this is what knows the settled frame is still the same update appearance.
   */
  skipSource: { currentSkipPredicate(): ((frameText: string) => boolean) | undefined } = {
    currentSkipPredicate: () => undefined,
  },
): (input: string) => Promise<AutomationWriteResult> {
  return guardedNonTrustAutomationWrite(terminal, write, readFrame, "codex", (frameText, input) => {
    if (!codexOptionStillSafe(frameText, input)) return false;
    // Non-option keys are not update automation, so the update predicate does not apply.
    if (!/^\d+$/.test(input)) return true;
    return skipSource.currentSkipPredicate()?.(frameText) ?? true;
  });
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
  return options.some(
    (option) => option.number === input && codexUpdateOptionPattern.test(option.label),
  );
}

/** `exhausted`: the retry budget ended while the safe option was still visible. */
export type CodexUpdateSkipCompletion = StartupWriteCompletion | "exhausted";

/** Retries a possibly swallowed startup hotkey only while its safe option remains visible. */
export async function writeCodexUpdateSkip(
  option: string,
  write: (input: string) => TrustWriteResult | Promise<AutomationWriteResult>,
  readFrame?: () => string,
  currentUpdateFrame: (frameText: string) => boolean = codexUpdatePromptVisible,
): Promise<CodexUpdateSkipCompletion> {
  if (readFrame === undefined) {
    // A guarded writer can still withhold (its own settled-frame checks apply), and a
    // key nobody sent is not an answer even with no reader to retry from.
    return (await write(option)) === "withheld" ? "cancelled" : "answered";
  }
  const deadline = Date.now() + retryTimeoutMs;
  let wrote = false;
  while (Date.now() < deadline) {
    const frame = readFrame();
    if (!currentUpdateFrame(frame)) return wrote ? "answered" : "cancelled";
    const safeOption = numberedOptions(frame).find((candidate) =>
      codexUpdateOptionPattern.test(candidate.label),
    );
    if (safeOption === undefined) return "cancelled";
    // A guarded writer settles rendering before the key goes out, so it may report the
    // key WITHHELD (a trust gate, or this option number no longer the safe one on the
    // settled frame). That is not an answer: leave the screen unanswered for a human
    // rather than counting a key nobody sent (C-CODEX-12, C-TRUST-01).
    if ((await write(safeOption.number)) === "withheld") return "cancelled";
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
