/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics (C-API-31).
 */

import type { ControlSubmitMode } from "./control-queue.ts";

type InputTerminal = { sendInput(data: string | Uint8Array): void | Promise<void> };

/** Adapter view of "the paste is still staged in the composer". */
export type PasteGuard = {
  readonly snapshot: () => string;
  readonly staged: (screen: string, prompt: string) => boolean;
  /**
   * True when a blocking human-decision dialog is on screen. A dialog can
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
/** How often the submitting Enter re-checks a blocking dialog before firing. */
export const blockedPollMs = 50;

/** Explicitly best-effort input for startup/recovery automation. */
export function ignoreInputFailure(input: void | Promise<void>): void {
  void Promise.resolve(input).catch(() => undefined);
}

/**
 * The TUIs ingest bracketed pastes asynchronously; an Enter concatenated into
 * the same PTY write races that ingestion and can be dropped, leaving the
 * prompt staged but never submitted (long personas hit this reliably). The
 * Enter therefore follows as a separate keystroke after a settle delay, and
 * bounded re-Enters fire while the screen still shows staged content — a
 * lone Enter from the staged state submits, and a surplus Enter on an empty
 * composer is a no-op, so the recovery is safe on both adapters.
 */
/**
 * Writes a bracketed paste and submits it. The returned promise resolves once
 * the first submitting Enter has been dispatched (after the settle delay), so
 * the control queue does not drain the next operation into the composer before
 * this prompt has actually been submitted. Bounded recovery re-Enters continue
 * in the background afterwards and are idempotent.
 */
export async function writePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  guard?: PasteGuard,
  settleDelayMs = pasteSettleDelayMs,
  nudgeDelayMs = pasteNudgeDelayMs,
): Promise<void> {
  await terminal.sendInput(`\u001b[200~${prompt}\u001b[201~`);
  const schedule = (work: () => void, ms: number) => {
    const timer = setTimeout(work, ms);
    timer.unref?.();
  };
  let nudges = 0;
  const nudge = async () => {
    if (!guard || nudges >= pasteNudgeAttempts) return;
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
  await wait(settleDelayMs);
  // Hold the submitting Enter while a blocking dialog is on screen: firing it
  // would confirm the dialog's highlighted option instead of submitting the
  // staged paste (C-API-37 dialog safety). The paste stays staged behind the
  // dialog and submits once it clears.
  await waitWhileBlocked(guard);
  await terminal.sendInput("\r");
  schedule(nudge, nudgeDelayMs);
}

function waitWhileBlocked(guard?: PasteGuard): Promise<void> {
  if (!guard?.blocked?.()) return Promise.resolve();
  return new Promise((resolve) => {
    const poll = () => {
      if (!guard.blocked?.()) {
        resolve();
        return;
      }
      const timer = setTimeout(poll, blockedPollMs);
      timer.unref?.();
    };
    const timer = setTimeout(poll, blockedPollMs);
    timer.unref?.();
  });
}

export async function writeQueuedInput(
  terminal: InputTerminal,
  input: string,
  mode: ControlSubmitMode,
  guard?: PasteGuard,
  enterDelayMs = commandEnterDelayMs,
): Promise<void> {
  if (mode !== "command") {
    // Resolve only after the input's submitting Enter has dispatched, so the
    // next queued operation cannot write into the composer first (FIFO).
    await writePastedPrompt(terminal, input, guard);
    return;
  }
  // Slash-command popups (Codex) swallow an Enter that arrives in the same
  // PTY chunk as the command text, so Enter follows as a separate keystroke.
  // The returned promise resolves only after that Enter is dispatched, so a
  // queued command's Enter always lands before the next operation writes.
  await terminal.sendInput(input);
  await wait(enterDelayMs);
  await terminal.sendInput("\r");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
