/**
 * Ordered xterm writes with disposal-safe completion.
 * Implements PRD §4.1 and C-PERF-05.
 */

type PendingWrite = {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

export class TerminalOutput {
  private readonly pending = new Set<PendingWrite>();
  private drained = Promise.resolve();
  private resolveDrained: (() => void) | undefined;
  private readonly write: (data: string | Uint8Array, callback: () => void) => void;

  constructor(write: (data: string | Uint8Array, callback: () => void) => void) {
    this.write = write;
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
        this.finish(pending);
        reject(error);
      }
    });
  }

  settled(): Promise<void> {
    return this.drained;
  }

  dispose(): void {
    for (const pending of this.pending) pending.resolve();
    this.pending.clear();
    this.release();
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
