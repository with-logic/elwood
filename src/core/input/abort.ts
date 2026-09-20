/** Abort-aware timing, dialog holds, and composer cleanup for queued input (PRD §5.3/§5.9, C-API-56). */

import { composerClearKeys, unsafeWriteRetryMs } from "./constants.ts";

/**
 * The narrow terminal surface the queued-input helpers drive. `settled` resolves once
 * every PTY byte received so far has been rendered and observed, and `renderFailed`
 * reports a render that did not happen; write-only test doubles omit both.
 */
export type InputTerminal = {
  sendInput(data: string | Uint8Array): void | Promise<void>;
  settled?(): Promise<void>;
  readonly renderFailed?: boolean;
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

/** One bounded attempt to observe received output: sustained output or a render backlog can exceed it. */
export const observeBudgetMs = 1_000;

/**
 * Hold a queued write while it is unsafe (see `writeUnsafe`). The caller writes in the
 * same turn this resolves, before any further PTY output can be delivered (C-API-56).
 * Cancellation interrupts the wait; the caller then rejects instead of writing.
 */
export async function holdWhileUnsafe(
  terminal: InputTerminal,
  guard?: { readonly blocked?: () => boolean },
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted && (await writeUnsafe(terminal, guard, signal))) {
    await delayUnref(unsafeWriteRetryMs);
  }
}

/**
 * True while a write must be withheld. `blocked` reads the last OBSERVED frame, and
 * rendering is asynchronous (§4.1): a dialog can be received yet unrendered, where
 * writing would type into it. So first observe everything received. When that cannot
 * be done — observation does not complete within the budget, a render has failed,
 * or the wait was cancelled — the screen cannot be
 * vouched for and the answer is `true`: fail closed, never write through.
 */
export async function writeUnsafe(
  terminal: InputTerminal,
  guard?: { readonly blocked?: () => boolean },
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true; // an abort listener added now would never fire
  if (terminal.settled && !(await observedWithinBudget(terminal.settled(), signal))) return true;
  return terminal.renderFailed === true || guard?.blocked?.() === true;
}

function observedWithinBudget(settled: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (observed: boolean) => {
      clearTimeout(budget);
      signal?.removeEventListener("abort", giveUp);
      resolve(observed);
    };
    const giveUp = () => finish(false);
    const budget = setTimeout(giveUp, observeBudgetMs);
    budget.unref?.();
    signal?.addEventListener("abort", giveUp, { once: true });
    void settled.then(() => finish(true));
  });
}

export function throwIfInputAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw inputAbortError(signal);
}

export function inputAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Submission aborted.");
}

export async function clearStagedComposer(terminal: InputTerminal): Promise<void> {
  try {
    await terminal.sendInput(composerClearKeys);
  } catch {
    // Best-effort: preserve the cancellation as the primary outcome.
  }
}
