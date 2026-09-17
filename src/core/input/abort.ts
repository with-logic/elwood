/** Abort-aware timing, dialog holds, and composer cleanup for queued input (PRD §5.3/§5.9, C-API-56). */

/**
 * The narrow terminal surface the queued-input helpers drive. `settled` resolves once
 * every PTY byte received so far has been rendered and observed; write-only test
 * doubles omit it.
 */
export type InputTerminal = {
  sendInput(data: string | Uint8Array): void | Promise<void>;
  settled?(): Promise<void>;
};

export function waitForInput(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return delayUnref(ms);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(inputAbortError(signal));
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(inputAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** An unreferenced sleep: a pending settle delay never keeps the host alive by itself. */
function delayUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** How often a held write re-checks a blocking dialog before firing. */
const blockedPollMs = 50;

/**
 * Hold a queued write while a dialog is on screen. `blocked` reads the last OBSERVED
 * frame, and rendering is asynchronous (§4.1): a dialog can already be received yet
 * unrendered, where writing would type into it. So first observe everything
 * received, then decide — the caller writes in the same turn this resolves, before
 * any further PTY output can be delivered (C-API-56).
 */
export async function holdWhileBlocked(
  terminal: InputTerminal,
  guard?: { readonly blocked?: () => boolean },
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    await terminal.settled?.();
    if (signal?.aborted || !guard?.blocked?.()) return;
    await delayUnref(blockedPollMs);
  }
}

export function throwIfInputAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw inputAbortError(signal);
}

export function inputAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Submission aborted.");
}

export async function clearStagedComposer(terminal: InputTerminal): Promise<void> {
  try {
    await terminal.sendInput("\u0015\u000b");
  } catch {
    // Best-effort: preserve the cancellation as the primary outcome.
  }
}
