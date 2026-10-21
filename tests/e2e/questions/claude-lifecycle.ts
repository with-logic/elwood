/** Join lazy startup on cancellation and always attempt private proof cleanup (PRD §12). */

export function claudeProofLifecycle(signal: AbortSignal) {
  let facade: { close(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  let cancellationClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!facade) return Promise.resolve();
    closing ??= facade.close();
    const attempt = closing;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return closing;
  };
  const abort = () => {
    cancellationClose = close();
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    async start<T>(active: { start(): Promise<T>; close(): Promise<void> }): Promise<T> {
      signal.throwIfAborted();
      facade = active;
      const live = await active.start();
      signal.throwIfAborted();
      return live;
    },
    async finish(
      actions: readonly (() => void | Promise<void>)[],
      primaryFailure: boolean,
      diagnostic: (message: string) => void,
    ): Promise<void> {
      signal.removeEventListener("abort", abort);
      const failures: unknown[] = [];
      const finishClose = async () => {
        // Join an abort-triggered attempt before retrying a transient shutdown failure.
        await cancellationClose?.catch(() => undefined);
        await close();
      };
      for (const action of [finishClose, ...actions]) {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      }
      if (!failures.length) return;
      if (!primaryFailure)
        throw new AggregateError(failures, "Claude question proof cleanup failed");
      try {
        diagnostic("Claude question proof cleanup also failed");
      } catch {
        // Reporting a secondary failure must preserve the original proof failure.
      }
    },
  };
}
