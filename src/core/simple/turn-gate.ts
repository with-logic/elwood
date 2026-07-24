/**
 * The completion gate for one ergonomic turn (PRD §5.8): a single-producer/single-consumer
 * async queue that ends a turn DETERMINISTICALLY once the transcript has caught up.
 *
 * `observeReady()` (on `ready`) begins completion checks and arms a `catchUpMs` failure cap. The
 * turn ends when the collected assistant text CONTAINS the Stop hook's expected text (the oracle),
 * or — with no expected text — after `quietMs` of no new content; if neither happens within
 * `catchUpMs` of `ready` it fails with `wait_timeout`. `end()`/`fail()` are IDEMPOTENT (first
 * completion wins). `done()` resolves/rejects at that completion for the runner; `drain()` is the
 * consumer view and finishes only once the queue is also empty (a completion racing ahead of the
 * last buffered event never truncates it).
 */

import { elwoodError } from "../errors.ts";
import { CompletenessOracle } from "./completeness-oracle.ts";
import { type TurnEvent, turnEventBytes } from "./events.ts";

// Cap on UNCONSUMED events buffered for a slow/paused consumer; past it the turn fails with a
// typed `wait_timeout` rather than growing without limit (a turn has no default whole-turn
// timeout). Large enough that a normally draining consumer never hits it.
const MAX_PENDING_EVENTS = 100_000;
// Compact the consumed prefix only past this many consumed events (so a small stream never
// churns splice on tiny arrays); the `head >= length/2` gate then keeps it amortised O(1).
const HEAD_COMPACT_MIN = 32;
// Cap on UNCONSUMED UTF-8 bytes for a slow consumer. The count cap alone cannot bound memory —
// a single event may carry an arbitrarily large agent-controlled string — so this byte
// high-water is the real exhaustion guard. 64 MiB: far above any legitimate backlog.
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** A queued event with its precomputed UTF-8 byte size, so drain never re-encodes it. */
type Queued = { readonly event: TurnEvent; readonly bytes: number };

export class TurnGate {
  private readonly queue: Queued[] = [];
  private head = 0; // index of the next unconsumed event (avoids O(n) Array.shift)
  private pendingBytes = 0; // sum of unconsumed event UTF-8 byte sizes (byte high-water guard)
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private readyObserved = false; // `ready` seen — completion checks may begin (NOT the turn end)
  private readonly oracle = new CompletenessOracle();
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly quietMs: number;
  private readonly catchUpMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private readonly donePromise: Promise<void>;

  constructor(
    quietMs: number,
    catchUpMs: number,
    maxPendingEvents = MAX_PENDING_EVENTS,
    maxPendingBytes = MAX_PENDING_BYTES,
  ) {
    this.quietMs = quietMs;
    this.catchUpMs = catchUpMs;
    this.maxPendingEvents = maxPendingEvents;
    this.maxPendingBytes = maxPendingBytes;
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

  /** Backing-array length — the retained storage. A CONTINUOUS stream must keep this bounded. */
  get backingSize(): number {
    return this.queue.length;
  }

  observeText(text: string): void {
    this.oracle.observeText(text);
    this.reconcile();
  }
  expectText(text: string | undefined): void {
    // Installing a NON-EMPTY oracle after `ready` (the Stop hook can lag `ready`) must cancel any
    // quiet-window fallback already armed: the promised text now governs completion, so the turn
    // waits for it (or the catch-up cap), not a quiet settle.
    if (this.oracle.expectText(text) && this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    this.reconcile();
  }
  push(event: TurnEvent): void {
    if (this.ended) return;
    // Bound unconsumed events AND bytes (a stalled consumer must not grow the buffer without
    // limit) — count catches a flood of small events, bytes a few huge payloads. Report WHICH
    // bound was hit so the diagnostic doesn't always blame the count.
    const bytes = turnEventBytes(event);
    const overCount = this.queue.length - this.head >= this.maxPendingEvents;
    const overBytes = this.pendingBytes + bytes > this.maxPendingBytes;
    if (overCount || overBytes) {
      const reason = overCount ? "events" : "bytes";
      this.fail(elwoodError("wait_timeout", `turn produced too many unconsumed ${reason}`));
      return;
    }
    this.queue.push({ event, bytes });
    this.pendingBytes += bytes;
    if (this.readyObserved) this.armQuiet(); // new content after ready: re-arm the fallback window
    this.wake?.();
  }
  /** `ready` observed — begin completion checks and arm the post-ready catch-up cap. */
  observeReady(): void {
    if (this.ended || this.readyObserved) return;
    this.readyObserved = true;
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
    if (this.ended || !this.readyObserved) return;
    if (this.oracle.hasExpected) {
      if (this.oracle.matched) this.end(); // caught up — deterministic
      return; // still waiting for the transcript to reach the expected text (catch-up cap guards)
    }
    this.armQuiet(); // no oracle (pure-tool / empty / StopFailure): bounded quiet settle
  }
  private armQuiet(): void {
    if (this.ended || this.oracle.hasExpected) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.end(), this.quietMs);
    this.quietTimer.unref?.();
  }
  async *drain(): AsyncGenerator<TurnEvent> {
    for (;;) {
      while (this.head < this.queue.length) {
        const queued = this.queue[this.head] as Queued;
        this.head += 1;
        this.pendingBytes -= queued.bytes; // precomputed on push — no re-encode here
        // Compact the consumed prefix once it dominates the array, so consumed events are freed
        // even in a CONTINUOUS stream that never empties (else the reset below is unreachable and
        // storage grows unbounded). Gated on head ≥ HALF → amortised O(1) per event, not O(n²).
        if (this.head >= HEAD_COMPACT_MIN && this.head * 2 >= this.queue.length) {
          this.queue.splice(0, this.head);
          this.head = 0;
        }
        yield queued.event;
      }
      // Fully caught up: reset the backing array so nothing lingers between turns.
      this.queue.length = 0;
      this.head = 0;
      if (this.error !== undefined) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
