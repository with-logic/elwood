/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics (C-API-31).
 */

import type { MessageSubmitMode } from "./message-queue.ts";

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
export function writePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  guard?: PasteGuard,
  settleDelayMs = pasteSettleDelayMs,
  nudgeDelayMs = pasteNudgeDelayMs,
): void {
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
  schedule(() => {
    enter();
    schedule(nudge, nudgeDelayMs);
  }, settleDelayMs);
}

export function writeQueuedInput(
  terminal: InputTerminal,
  message: string,
  mode: MessageSubmitMode,
  guard?: PasteGuard,
  enterDelayMs = commandEnterDelayMs,
): void {
  if (mode !== "command") {
    writePastedPrompt(terminal, message, guard);
    return;
  }
  // Slash-command popups (Codex) swallow an Enter that arrives in the same
  // PTY chunk as the command text, so Enter follows as a separate keystroke.
  terminal.sendInput(message);
  const timer = setTimeout(() => {
    try {
      terminal.sendInput("\r");
    } catch {
      // The session may have terminated while the Enter keystroke was pending.
    }
  }, enterDelayMs);
  timer.unref?.();
}
