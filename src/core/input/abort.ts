/** Abort-aware timing and composer cleanup for queued input (PRD §5.3/§5.9). */

/** The narrow PTY write surface the queued-input helpers drive. */
export type InputTerminal = { sendInput(data: string | Uint8Array): void | Promise<void> };

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
