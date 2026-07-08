/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics (C-API-31).
 */

import type { ControlSubmitMode } from "./control-queue.ts";

type InputTerminal = { sendInput(data: string | Uint8Array): void };

/** Adapter view of "the paste is still staged in the composer". */
export type PasteGuard = {
  readonly snapshot: () => string;
  readonly staged: (screen: string, prompt: string) => boolean;
};

export const commandEnterDelayMs = 150;
export const pasteSettleDelayMs = 150;
export const pasteNudgeDelayMs = 1_000;
export const pasteNudgeAttempts = 2;

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
export function writePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  guard?: PasteGuard,
  settleDelayMs = pasteSettleDelayMs,
  nudgeDelayMs = pasteNudgeDelayMs,
): Promise<void> {
  terminal.sendInput(`\u001b[200~${prompt}\u001b[201~`);
  const enter = () => {
    try {
      terminal.sendInput("\r");
    } catch {
      // The session may have terminated while the keystroke was pending.
    }
  };
  const schedule = (work: () => void, ms: number) => {
    const timer = setTimeout(work, ms);
    timer.unref?.();
  };
  let nudges = 0;
  const nudge = () => {
    if (!guard || nudges >= pasteNudgeAttempts) return;
    nudges += 1;
    if (!guard.staged(guard.snapshot(), prompt)) return;
    enter();
    schedule(nudge, nudgeDelayMs);
  };
  return new Promise((resolve) => {
    schedule(() => {
      enter();
      schedule(nudge, nudgeDelayMs);
      resolve();
    }, settleDelayMs);
  });
}

export function writeQueuedInput(
  terminal: InputTerminal,
  message: string,
  mode: ControlSubmitMode,
  guard?: PasteGuard,
  enterDelayMs = commandEnterDelayMs,
): Promise<void> {
  if (mode !== "command") {
    // Resolve only after the message's submitting Enter has dispatched, so the
    // next queued operation cannot write into the composer first (FIFO).
    return writePastedPrompt(terminal, message, guard);
  }
  // Slash-command popups (Codex) swallow an Enter that arrives in the same
  // PTY chunk as the command text, so Enter follows as a separate keystroke.
  // The returned promise resolves only after that Enter is dispatched, so a
  // queued command's Enter always lands before the next operation writes.
  terminal.sendInput(message);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        terminal.sendInput("\r");
      } catch {
        // The session may have terminated while the Enter keystroke was pending.
      }
      resolve();
    }, enterDelayMs);
    timer.unref?.();
  });
}
