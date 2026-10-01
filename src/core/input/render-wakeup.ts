/** One coalesced completed-frame wakeup and optional paced retry (PRD §5.3, C-API-31). */
import { inputAbortError } from "./abort.ts";

export class RenderWakeup {
  private dirty = false;
  private wake: (() => void) | undefined;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(subscribe: ((listener: () => void) => () => void) | undefined) {
    this.unsubscribe = subscribe?.(() => {
      this.dirty = true;
      this.wake?.();
    });
  }

  consume(): void {
    this.dirty = false;
  }

  wait(signal: AbortSignal | undefined, retryInMs?: number): Promise<void> {
    if (this.dirty) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        this.wake = undefined;
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(inputAbortError(signal as AbortSignal));
      };
      this.wake = () => {
        cleanup();
        resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (retryInMs !== undefined) {
        timer = setTimeout(this.wake, retryInMs);
        timer.unref?.();
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
