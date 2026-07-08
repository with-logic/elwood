/**
 * Screen-state polling primitives for TUI automation flows.
 * Implements PRD §5.3 model picker automation.
 */

import { elwoodError } from "./errors.ts";

export type ScreenTerminal = {
  sendInput(data: string | Uint8Array): void;
  snapshot(): { readonly text: string };
};

export const defaultModelTimeoutMs = 20_000;
const pollMs = 100;
const openNudgeDelayMs = 2_000;

export async function waitForScreen(
  terminal: ScreenTerminal,
  test: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = terminal.snapshot().text;
    if (test(text)) return text;
    await delay(pollMs);
  }
  throw elwoodError("model_automation_failed", `Timed out waiting for ${label}.`);
}

export async function openCommandScreen(input: {
  readonly terminal: ScreenTerminal;
  readonly submit: () => Promise<void>;
  readonly isOpen: (text: string) => boolean;
  readonly timeoutMs: number;
  readonly label: string;
  readonly nudgeDelayMs?: number;
}): Promise<string> {
  await input.submit();
  // The command text or its Enter can be dropped when the TUI is redrawing
  // (e.g. an MCP-server boot streaming into the composer at startup). A bare
  // Enter nudge cannot recover a lost command line, so re-submit the whole
  // command on each nudge interval until the picker opens or the timeout
  // fires. Re-typing an idempotent slash command on an empty composer, and a
  // surplus Enter, are both no-ops once the picker is already open.
  const nudgeDelayMs = input.nudgeDelayMs ?? openNudgeDelayMs;
  let resubmitting = false;
  let nudgeTimer: ReturnType<typeof setInterval> | undefined;
  // A re-submit that rejects (e.g. the session closed while polling) must
  // settle this call with that error immediately, not be dropped as an
  // unhandled rejection while the caller waits out the picker timeout.
  const submitFailed = new Promise<never>((_resolve, reject) => {
    nudgeTimer = setInterval(() => {
      if (resubmitting || input.isOpen(input.terminal.snapshot().text)) return;
      resubmitting = true;
      // A rejected re-submit (e.g. the session closed) propagates verbatim;
      // `controlQueue.send` only ever rejects with a typed ElwoodError.
      input.submit().then(() => {
        resubmitting = false;
      }, reject);
    }, nudgeDelayMs);
  });
  try {
    return await Promise.race([
      waitForScreen(input.terminal, input.isOpen, input.timeoutMs, input.label),
      submitFailed,
    ]);
  } finally {
    clearInterval(nudgeTimer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
