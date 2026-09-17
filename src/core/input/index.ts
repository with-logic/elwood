/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics (C-API-31).
 */

import type { ControlSubmitMode } from "../control-queue/index.ts";
import {
  clearStagedComposer,
  holdWhileBlocked,
  type InputTerminal,
  throwIfInputAborted,
  waitForInput,
} from "./abort.ts";

/** Adapter view of "the paste is still staged in the composer". */
export type PasteGuard = {
  readonly snapshot: () => string;
  readonly staged: (screen: string, prompt: string) => boolean;
  /**
   * True when a human or automation-owned dialog is on screen. A dialog can
   * appear during the paste-settle window; sending the submitting Enter then
   * would confirm the dialog's highlighted option (e.g. approve a tool). The
   * Enter is therefore held while this is true and retried once it clears.
   */
  readonly blocked?: () => boolean;
};

export const commandEnterDelayMs = 150;
export const pasteSettleDelayMs = 150;
export const pasteNudgeDelayMs = 1_000;
export const pasteNudgeAttempts = 2;

/** Explicitly best-effort input for startup/recovery automation. */
export function ignoreInputFailure(input: void | Promise<void>): void {
  void Promise.resolve(input).catch(() => undefined);
}

// C0 (\u0000-\u001f) and C1 (\u007f-\u009f) control chars EXCEPT tab,
// newline, and carriage return, which are legitimate multi-line whitespace.
// Stripping ESC (\u001b) alone already defuses the ESC[200~ / ESC[201~
// bracketed-paste sentinels, leaving only inert `[20x~` text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control input is the point.
const pasteUnsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Neutralizes caller/model text before it is framed as a bracketed paste (§5.3).
 * Message text is data, so an embedded `ESC[201~` end sentinel (or a bare control
 * byte) MUST NOT terminate paste mode early and turn following bytes into live
 * keystrokes — e.g. an Enter that confirms a permission dialog. Tab, newline, and
 * carriage return survive as legitimate multi-line text; everything else is
 * stripped. `sendKeys` is the raw escape hatch and never goes through here.
 */
export function sanitizePasteText(text: string): string {
  return text.replace(pasteUnsafe, "");
}

/**
 * Writes a bracketed paste and submits it.
 *
 * The TUIs ingest bracketed pastes asynchronously; an Enter concatenated into
 * the same PTY write races that ingestion and can be dropped, leaving the prompt
 * staged but never submitted (long personas hit this reliably). The Enter
 * therefore follows as a separate keystroke after a settle delay, and bounded
 * re-Enters fire while the screen still shows staged content — a lone Enter from
 * the staged state submits, and a surplus Enter on an empty composer is a no-op,
 * so the recovery is safe on both adapters.
 *
 * While a human or automation-owned dialog is on screen, the WHOLE submission is
 * held: neither the paste nor any Enter reaches the terminal until the dialog
 * clears, so caller/model text can never be interpreted as the dialog's
 * shortcuts or confirm its highlighted option (C-API-37 dialog safety). Paste
 * text is sanitized first so an embedded end sentinel or control byte cannot
 * escape paste mode into live keystrokes (§5.3).
 *
 * The returned promise resolves once the first submitting Enter has been
 * dispatched (after the settle delay), so the control queue does not drain the
 * next operation into the composer before this prompt has actually been
 * submitted. Bounded recovery re-Enters continue in the background afterwards
 * and are idempotent.
 */
async function writePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  guard?: PasteGuard,
  signal?: AbortSignal,
  settleDelayMs = pasteSettleDelayMs,
  nudgeDelayMs = pasteNudgeDelayMs,
): Promise<void> {
  // Hold the WHOLE submission — paste included — while a blocking dialog is on
  // screen. A dialog can appear before an overtaking guidance's paste dispatches;
  // pasting caller/model text into it risks the TUI interpreting shortcuts, so no
  // bytes may reach a dialog until it clears (C-API-37 dialog safety). A write-only
  // terminal with nothing blocking has nothing to wait for and writes synchronously.
  if (terminal.settled || guard?.blocked?.()) await holdWhileBlocked(terminal, guard, signal);
  throwIfInputAborted(signal);
  // Sanitize: caller/model text is data, so an embedded end sentinel or control
  // byte must not escape paste mode into live keystrokes (§5.3).
  await terminal.sendInput(`\u001b[200~${sanitizePasteText(prompt)}\u001b[201~`);
  const schedule = (work: () => void, ms: number) => {
    const timer = setTimeout(work, ms);
    timer.unref?.();
  };
  let nudges = 0;
  const nudge = async () => {
    // Decide on the current screen: a dialog may be received but not yet rendered.
    await terminal.settled?.();
    // Stop once a LATER submission has begun: a stale nudge must never fire an
    // Enter into a newer prompt's paste (the staged chip is not prompt-specific).
    if (signal?.aborted || !guard || nudges >= pasteNudgeAttempts) return;
    // A dialog that appears after the first Enter must not be confirmed by a
    // recovery Enter either; skip this attempt and re-check on the next tick.
    if (guard.blocked?.()) {
      schedule(nudge, nudgeDelayMs);
      return;
    }
    nudges += 1;
    if (!guard.staged(guard.snapshot(), prompt)) return;
    try {
      await terminal.sendInput("\r");
    } catch {
      // Recovery nudges are best-effort after the first Enter already landed.
    }
    schedule(nudge, nudgeDelayMs);
  };
  try {
    await waitForInput(settleDelayMs, signal);
    // Hold the submitting Enter while a blocking dialog is on screen: firing it
    // would confirm the dialog's highlighted option instead of submitting the
    // staged paste (C-API-37 dialog safety). The paste stays staged behind the
    // dialog and submits once it clears.
    await holdWhileBlocked(terminal, guard, signal);
    throwIfInputAborted(signal);
    await terminal.sendInput("\r");
  } catch (error) {
    if (signal?.aborted && !guard?.blocked?.()) await clearStagedComposer(terminal);
    throw error;
  }
  schedule(nudge, nudgeDelayMs);
}

export async function writeQueuedInput(
  terminal: InputTerminal,
  input: string,
  mode: ControlSubmitMode,
  guard?: PasteGuard,
  signal?: AbortSignal,
  enterDelayMs = commandEnterDelayMs,
): Promise<void> {
  // Dispatch through a Record keyed by ControlSubmitMode: a new mode must add an
  // entry here or the object fails to type-check, so it can never silently reuse
  // pasted-input behavior. The map has no unreachable default arm, so 100%
  // coverage holds (both entries are exercised).
  const submitters: Readonly<Record<ControlSubmitMode, () => Promise<void>>> = {
    // Resolve only after the input's submitting Enter has dispatched, so the next
    // queued operation cannot write into the composer first (FIFO).
    pasted_input: () => writePastedPrompt(terminal, input, guard, signal),
    // Slash-command popups (Codex) swallow an Enter that arrives in the same PTY
    // chunk as the command text, so Enter follows as a separate keystroke. The
    // returned promise resolves only after that Enter is dispatched, so a queued
    // command's Enter always lands before the next operation writes.
    command: async () => {
      if (terminal.settled || guard?.blocked?.()) await holdWhileBlocked(terminal, guard, signal);
      throwIfInputAborted(signal);
      await terminal.sendInput(input);
      try {
        await waitForInput(enterDelayMs, signal);
        await holdWhileBlocked(terminal, guard, signal);
        throwIfInputAborted(signal);
        await terminal.sendInput("\r");
      } catch (error) {
        if (signal?.aborted && !guard?.blocked?.()) await clearStagedComposer(terminal);
        throw error;
      }
    },
  };
  await submitters[mode]();
}
