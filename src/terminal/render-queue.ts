/**
 * Ordered xterm writes with disposal-safe completion, generation-aware settlement and
 * a permanent render-failure state, so callers can tell whether the screen reflects
 * everything received. Implements PRD §4.1/§5.3, C-PERF-06 and C-API-56.
 */

type PendingWrite = {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

type XtermWrite = (data: string | Uint8Array, done: () => void) => void;

export class RenderQueue {
  /** True once any write has failed; nothing later can prove the screen complete again. */
  renderFailed = false;
  private readonly pending = new Set<PendingWrite>();
  private drained = Promise.resolve();
  private resolveDrained: (() => void) | undefined;
  private settling: Promise<void> | undefined;
  /** Set by a settle pass that finished, so `settled()` can tell it never awaited. */
  private settlePassDone = false;
  private readonly write: XtermWrite;
  private readonly submitStaged: () => void;

  /** `submitStaged` hands over any output a batching layer still holds back. */
  constructor(write: XtermWrite, submitStaged: () => void = () => undefined) {
    this.write = write;
    this.submitStaged = submitStaged;
  }

  enqueue(data: string | Uint8Array, onRendered?: () => void): Promise<void> {
    if (this.pending.size === 0) {
      this.drained = new Promise((resolve) => {
        this.resolveDrained = resolve;
      });
    }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      this.pending.add(pending);
      try {
        // xterm already preserves write order and yields while draining. Feeding
        // its buffer directly avoids paying a fresh timer for every PTY chunk.
        this.write(data, () => this.complete(pending, onRendered));
      } catch (error) {
        // The bytes are gone and the parser may be mid-sequence; no later output can
        // prove a complete resynchronization, so the failure is permanent.
        this.renderFailed = true;
        this.finish(pending);
        reject(error);
      }
    });
  }

  /** One shared traversal: a caller that gave up and retries joins it, never stacks. */
  settled(): Promise<void> {
    if (this.settling !== undefined) return this.settling;
    this.settlePassDone = false;
    const settling = this.settle();
    // A pass that finds nothing pending completes WITHOUT ever awaiting, so it has
    // already finished by the time it returns here. Memoizing it would strand a
    // resolved promise: every later caller would join it and return without
    // observing new output, silently losing the barrier queued writes rely on
    // (C-API-56). Only an unfinished pass is worth sharing.
    if (!this.settlePassDone) this.settling = settling;
    return settling;
  }

  dispose(): void {
    for (const pending of this.pending) pending.resolve();
    this.pending.clear();
    this.release();
  }

  private async settle(): Promise<void> {
    // Output received while waiting is staged or submitted behind this pass, so submit
    // and drain again until a pass finds nothing. Observers run inside each write's
    // render callback, so every one of them has run by the time this resumes.
    this.submitStaged();
    while (this.pending.size > 0) {
      await this.drained;
      this.submitStaged();
    }
    this.settlePassDone = true;
    this.settling = undefined;
  }

  private complete(pending: PendingWrite, onRendered: (() => void) | undefined): void {
    if (!this.pending.has(pending)) return; // disposed while xterm still held the callback
    try {
      // Run observers inside the ordered render callback: a promise continuation
      // could otherwise observe a newer frame from the same xterm drain batch.
      onRendered?.();
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    } finally {
      this.finish(pending);
    }
  }

  private finish(pending: PendingWrite): void {
    this.pending.delete(pending);
    this.release();
  }

  private release(): void {
    if (this.pending.size === 0) {
      this.resolveDrained?.();
      this.resolveDrained = undefined;
    }
  }
}
