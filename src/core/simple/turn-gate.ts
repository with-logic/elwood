/**
 * The completion gate for one ergonomic turn (PRD §5.8): a single-producer/single-consumer
 * async queue that ends a turn DETERMINISTICALLY once the transcript has caught up.
 *
 * `settle()` (on `ready`) begins completion checks and arms a `catchUpMs` failure cap. The
 * turn ends when the collected assistant text CONTAINS the Stop hook's expected text (the
 * completeness oracle), or — with no expected text — after `quietMs` of no new content; if
 * neither happens within `catchUpMs` of `ready`, it fails with `wait_timeout`. `end()` and
 * `fail()` are IDEMPOTENT (first completion wins — a later timer can never overwrite a
 * success). `done()` resolves/rejects at that first completion for the turn runner; the
 * separate `drain()` generator is the consumer view and finishes only once the queue is
 * also empty, so a completion racing ahead of the last buffered event never truncates it.
 */

import { elwoodError } from "../errors.ts";
import type { TurnEvent } from "./events.ts";

const HEAD_COMPACT_THRESHOLD = 1024; // compact the consumed queue prefix past this many items

export class TurnGate {
  private readonly queue: TurnEvent[] = [];
  private head = 0; // index of the next unconsumed event (avoids O(n) Array.shift)
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private settled = false; // `ready` seen: the turn is completing
  private expected: string | undefined; // Stop hook's last_assistant_message, trimmed
  private collected = ""; // transcript assistant text seen so far
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly quietMs: number;
  private readonly catchUpMs: number;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private readonly donePromise: Promise<void>;

  constructor(quietMs: number, catchUpMs: number) {
    this.quietMs = quietMs;
    this.catchUpMs = catchUpMs;
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.donePromise.catch(() => {
      // Swallow: `done()` may reject before/without a runner awaiting it (e.g. an early
      // failure); the error still reaches the consumer via `drain()`. No unhandled rejection.
    });
  }

  /** Resolves at the real turn boundary; rejects on failure/timeout. For the turn runner. */
  done(): Promise<void> {
    return this.donePromise;
  }

  observeText(text: string): void {
    this.collected += text;
    this.reconcile();
  }
  expectText(text: string | undefined): void {
    const trimmed = text?.trim();
    this.expected = trimmed ? trimmed : undefined;
    this.reconcile();
  }
  push(event: TurnEvent): void {
    if (this.ended) return;
    this.queue.push(event);
    if (this.settled) this.armQuiet(); // new content after ready: re-arm the fallback window
    this.wake?.();
  }
  /** `ready` observed — begin completion checks and arm the post-ready catch-up cap. */
  settle(): void {
    if (this.ended || this.settled) return;
    this.settled = true;
    this.catchUpTimer = setTimeout(
      () => this.fail(elwoodError("wait_timeout", "transcript did not catch up after ready")),
      this.catchUpMs,
    );
    this.catchUpTimer.unref?.();
    this.reconcile();
  }
  /** Complete the turn (idempotent — the first completion wins). */
  end(): void {
    if (this.ended) return;
    this.dispose();
    this.ended = true;
    this.resolveDone();
    this.wake?.();
  }
  /** Fail the turn (idempotent — a late timer cannot overwrite an already-committed end). */
  fail(error: unknown): void {
    if (this.ended) return;
    this.dispose();
    this.error = error;
    this.ended = true;
    this.rejectDone(error);
    this.wake?.();
  }
  /** Clear every timer (idempotent); called on end/fail. */
  dispose(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.quietTimer = undefined;
    this.catchUpTimer = undefined;
  }
  /** End now if the transcript has caught up to the expected text; else arm the fallback. */
  private reconcile(): void {
    if (this.ended || !this.settled) return;
    if (this.expected !== undefined) {
      if (this.collected.includes(this.expected)) this.end(); // caught up — deterministic
      return; // still waiting for the transcript to reach the expected text (catch-up cap guards)
    }
    this.armQuiet(); // no oracle (pure-tool / empty / StopFailure): bounded quiet settle
  }
  private armQuiet(): void {
    if (this.ended || this.expected !== undefined) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.end(), this.quietMs);
    this.quietTimer.unref?.();
  }
  async *drain(): AsyncGenerator<TurnEvent> {
    for (;;) {
      while (this.head < this.queue.length) {
        const event = this.queue[this.head] as TurnEvent;
        this.head += 1;
        if (this.head > HEAD_COMPACT_THRESHOLD) {
          this.queue.splice(0, this.head); // drop the consumed prefix so the array cannot grow forever
          this.head = 0;
        }
        yield event;
      }
      if (this.error !== undefined) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
