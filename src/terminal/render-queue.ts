/**
 * Ordered xterm writes with generation-aware settlement and a permanent render-failure
 * state, so callers can tell whether the screen reflects everything received.
 * Implements PRD §4.1/§5.3 and C-API-56.
 */

export class RenderQueue {
  /** True once any write has failed; nothing later can prove the screen complete again. */
  renderFailed = false;
  private tail = Promise.resolve();
  private settling: Promise<void> | undefined;
  private readonly write: (data: string | Uint8Array, done: () => void) => void;

  constructor(write: (data: string | Uint8Array, done: () => void) => void) {
    this.write = write;
  }

  enqueue(data: string | Uint8Array): Promise<void> {
    const write = this.tail.then(() => new Promise<void>((done) => this.write(data, done)));
    // Chain the NEXT write off a never-rejecting tail so a single failed write (e.g.
    // a synchronous xterm.write throw) cannot poison every subsequent write. The
    // caller still sees the real result via the returned `write` promise. A failed
    // write's bytes are gone and the parser may be mid-sequence; no later output can
    // prove a complete resynchronization, so the failure is permanent.
    this.tail = write.catch(() => {
      this.renderFailed = true;
    });
    return write;
  }

  /** One shared traversal: a caller that gave up and retries joins it, never stacks. */
  settled(): Promise<void> {
    this.settling ??= this.settle();
    return this.settling;
  }

  private async settle(): Promise<void> {
    // Output received while waiting extends the queue, so settle again until a pass
    // adds nothing. Each PTY chunk's observer is a continuation of its own write
    // registered before this await, so it has run by the time this resumes.
    for (let tail: Promise<void> | undefined; tail !== this.tail; ) {
      tail = this.tail;
      await tail;
    }
    this.settling = undefined;
  }
}
