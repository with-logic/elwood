/** Abort-aware timing and composer cleanup for queued input (PRD §5.3/§5.9). */

type InputTerminal = { sendInput(data: string | Uint8Array): void | Promise<void> };

export function waitForInput(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => {
      if (timer) clearTimeout(timer);
      reject(inputAbortError(signal as AbortSignal));
    };
    if (signal?.aborted) {
      aborted();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", aborted, { once: true });
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
