/**
 * A render-settlement barrier for AUTOMATED startup-prompt writes.
 * Implements PRD §5.1/§5.4 and C-API-56: rendering is asynchronous (§4.1), so a dialog
 * can be RECEIVED while the last observed frame is still the previous screen. Startup
 * automation decides from that observed frame, so without a barrier a skip, decline, or
 * navigation key could be written against a snapshot that is already stale. Every
 * automated write therefore observes all received output first and fails closed when it
 * cannot — the same guarantee queued caller input already has (§5.3).
 *
 * The barrier answers WHEN a snapshot can be trusted, never WHAT is on it. Each
 * responder keeps its own recognition and decides, on the settled frame it re-reads,
 * whether its prompt is still the one to answer.
 */

import { type InputTerminal, writeUnsafe } from "../input/abort.ts";

/** What an automation write returns: adapters await it, void writers settle immediately. */
export type AutomationWrite = (input: string) => void | Promise<void>;

/**
 * Wrap an automation write so it only reaches the PTY once everything received has been
 * observed. Withholding is a safe, silent outcome — the automation stays retryable on a
 * later frame — not a write failure, so it emits no activity and no warning.
 */
export function guardedAutomationWrite(
  terminal: InputTerminal,
  write: AutomationWrite,
): (input: string) => Promise<void> {
  return async (input) => {
    // `writeUnsafe` awaits `terminal.settled()`, so a responder re-reading the frame
    // after this sees every byte received before the write was requested. It fails
    // closed when observation exceeds its budget or a render failed (C-API-56).
    if (await writeUnsafe(terminal)) return;
    await write(input);
  };
}
