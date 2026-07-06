/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics.
 */

import type { MessageSubmitMode } from "./message-queue.ts";

type InputTerminal = { sendInput(data: string | Uint8Array): void };

export const commandEnterDelayMs = 150;

export function writePastedPrompt(terminal: InputTerminal, prompt: string): void {
  terminal.sendInput(`\u001b[200~${prompt}\u001b[201~\r`);
}

export function writeQueuedInput(
  terminal: InputTerminal,
  message: string,
  mode: MessageSubmitMode,
  enterDelayMs = commandEnterDelayMs,
): void {
  if (mode !== "command") {
    writePastedPrompt(terminal, message);
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
