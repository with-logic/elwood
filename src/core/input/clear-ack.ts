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
 * Positive empty-composer evidence: reuse one token for each completed frame and
 * return a distinct token only for a later completed frame, never for each poll.
 * Return undefined when there is no completed, positively empty native composer.
 */
export type EmptyComposerObserver = () => object | undefined;

export async function clearAndObserveComposer(
  terminal: InputTerminal,
  blocked: () => boolean,
  observeEmpty: EmptyComposerObserver,
  signal: AbortSignal,
): Promise<void> {
  const before = observeEmpty();
  throwIfInputAborted(signal);
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
      if (after !== undefined && after !== before) return;
      await waitForInput(unsafeWriteRetryMs, waiting);
    }
  } finally {
    clearTimeout(timer);
  }
}
