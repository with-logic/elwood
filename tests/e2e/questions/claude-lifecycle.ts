/** Join lazy startup on cancellation and always attempt private proof cleanup (PRD §12). */

export type ClaudeProofLifecycle = ReturnType<typeof claudeProofLifecycle>;

/**
 * Runs isolated proof sessions one at a time. node:test starts the next test when one times out,
 * so each session waits for the previous body's cleanup, and none starts after a session whose
 * Claude shutdown was never confirmed.
 */
export function claudeProofQueue() {
  let previous: Promise<void> = Promise.resolve();
  let unconfirmed = false;
  return (signal: AbortSignal, prove: (lifecycle: ClaudeProofLifecycle) => Promise<void>) => {
    const lifecycle = claudeProofLifecycle(signal);
    const run = previous.then(() => {
      if (unconfirmed) throw new Error("An earlier Claude proof session did not confirm shutdown");
      return prove(lifecycle);
    });
    previous = run.catch(() => {
      unconfirmed ||= !lifecycle.closed;
    });
    return run;
  };
}

export function claudeProofLifecycle(signal: AbortSignal) {
  let facade: { close(): Promise<void> } | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let cancellationClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!facade) return Promise.resolve();
    closing ??= facade.close().then(() => {
      closed = true;
    });
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
    /** Whether no Claude session was started, or its close has resolved. */
    get closed() {
      return facade === undefined || closed;
    },
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
