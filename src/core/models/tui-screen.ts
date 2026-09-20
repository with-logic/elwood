/**
 * Screen-state polling primitives for TUI automation flows.
 * Implements PRD §5.3 model picker automation.
 */

import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";

export type ScreenTerminal = {
  sendInput(data: string | Uint8Array): void | Promise<void>;
  snapshot(): { readonly text: string };
};

export const defaultModelTimeoutMs = 20_000;
const pollMs = 100;
const openNudgeDelayMs = 2_000;

/**
 * Polls until `test` passes, the deadline elapses, or `signal` aborts.
 *
 * `signal` is the OPERATION's budget, shared by every phase; `timeoutMs` bounds this phase.
 * Without the signal a timed-out operation kept polling through each remaining phase's own
 * timeout while holding the exclusive queue slot, and a match arriving after the deadline
 * was reported as success. The abort is re-checked after `test` passes for that reason: a
 * frame that satisfies a phase whose operation has already expired is not a result.
 */
export async function waitForScreen(
  terminal: ScreenTerminal,
  test: (text: string) => boolean,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    const text = terminal.snapshot().text;
    if (test(text)) {
      signal?.throwIfAborted();
      return text;
    }
    await delay(pollMs);
  }
  signal?.throwIfAborted();
  throw elwoodError("model_automation_failed", `Timed out waiting for ${label}.`);
}

export async function openCommandScreen(input: {
  readonly terminal: ScreenTerminal;
  readonly submit: (signal: AbortSignal) => Promise<void>;
  readonly isOpen: (text: string) => boolean;
  readonly timeoutMs: number;
  readonly label: string;
  readonly nudgeDelayMs?: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const pending = new AbortController();
  let deadline: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      const error = elwoodError("model_automation_failed", `Timed out waiting for ${input.label}.`);
      pending.abort(error);
      reject(error);
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([
      openWithRetries(
        input,
        input.signal === undefined
          ? pending.signal
          : AbortSignal.any([pending.signal, input.signal]),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(deadline!);
    pending.abort();
  }
}

async function openWithRetries(
  input: Parameters<typeof openCommandScreen>[0],
  signal: AbortSignal,
): Promise<string> {
  await input.submit(signal);
  if (signal.aborted) throw signal.reason;
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
      // A rejected re-submit (e.g. the session closed while polling) is
      // propagated unchanged so the caller settles with the real error.
      input.submit(signal).then(() => {
        resubmitting = false;
      }, reject);
    }, nudgeDelayMs);
  });
  const stop = () => clearInterval(nudgeTimer);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([
      waitForScreen(input.terminal, input.isOpen, input.timeoutMs, input.label, signal),
      submitFailed,
    ]);
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
  }
}
