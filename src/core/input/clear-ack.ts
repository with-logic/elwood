/** Observe native consumption of owned clear keys before releasing input (C-API-56). */
import {
  type InputTerminal,
  observeBudgetMs,
  throwIfInputAborted,
  waitForInput,
  writeUnsafe,
} from "./abort.ts";
import { composerClearKeys, unsafeWriteRetryMs } from "./constants.ts";

/**
 * Positive empty-composer evidence. The same cached rows and geometry share a
 * token. Only the native progress check establishes new PTY output after a write.
 * Return undefined until a completed frame proves the composer is empty.
 */
export type EmptyComposerObserver = () => object | undefined;

export async function clearAndObserveComposer(
  terminal: InputTerminal,
  blocked: () => boolean,
  observeEmpty: EmptyComposerObserver,
  signal: AbortSignal,
  captureRenderProgress: () => () => boolean,
): Promise<void> {
  const before = observeEmpty();
  throwIfInputAborted(signal);
  const progressed = captureRenderProgress();
  await terminal.sendInput(composerClearKeys);
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("Composer clear was not observed.")),
    observeBudgetMs,
  );
  const waiting = AbortSignal.any([signal, deadline.signal]);
  try {
    for (;;) {
      throwIfInputAborted(waiting);
      if (await writeUnsafe(terminal, { blocked }, waiting))
        throw new Error("Composer observation is unsafe.");
      const after = observeEmpty();
      if (after !== undefined && after !== before && progressed()) return;
      await waitForInput(unsafeWriteRetryMs, waiting);
    }
  } finally {
    clearTimeout(timer);
  }
}
