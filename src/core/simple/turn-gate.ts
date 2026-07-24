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
import { type TurnEvent, turnEventBytes } from "./events.ts";

/**
 * Cap on UNCONSUMED events buffered for a slow/paused consumer. A turn has no default
 * whole-turn timeout, so without a bound a hostile or very verbose turn feeding a stalled
 * consumer could exhaust the host. Past this many pending events the turn fails with a
 * typed `wait_timeout` rather than growing without limit. Large enough that a normally
 * draining consumer never hits it.
 */
const MAX_PENDING_EVENTS = 100_000;
/**
 * Cap on UNCONSUMED bytes (sum of text/tool payload lengths) buffered for a slow consumer.
 * The event-count cap alone does not bound memory — a single event can carry an arbitrarily
 * large agent-controlled string — so a byte high-water mark is the real exhaustion guard.
 * 64 MiB: far above any legitimate single turn's pending backlog, well below host limits.
 */
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
/**
 * Extra tail (chars) retained beyond the oracle's expected length so a match that straddles
 * the fragment boundary is not missed. The oracle only needs the RECENT tail of the
 * collected assistant text, so `collected` is a bounded rolling window, not the whole turn.
 */
const ORACLE_TAIL_SLACK = 4096;
/**
 * Cap on the oracle's expected-text length (chars). The Stop hook's `last_assistant_message`
 * is agent-controlled; a hostile huge payload would otherwise size the rolling `collected`
 * window without limit. Matching only the LAST `EXPECTED_MAX` chars of the expected text is a
 * safe completeness signal (the transcript still contains that suffix) with bounded memory.
 */
const EXPECTED_MAX = 1024 * 1024;

export class TurnGate {
  private readonly queue: TurnEvent[] = [];
  private head = 0; // index of the next unconsumed event (avoids O(n) Array.shift)
  private pendingBytes = 0; // sum of unconsumed event payload lengths (byte high-water guard)
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
  private readonly maxPending: number;
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
    this.maxPending = maxPendingEvents;
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

  observeText(text: string): void {
    // BOUNDED rolling window: the oracle only needs the recent tail of the assistant text to
    // find the expected substring, so a very long turn does not retain the whole transcript.
    this.collected = (this.collected + text).slice(-this.oracleWindow());
    this.reconcile();
  }
  expectText(text: string | undefined): void {
    const trimmed = text?.trim();
    // Cap the agent-controlled expected text so the rolling `collected` window stays bounded;
    // its SUFFIX still appears in the transcript, so a suffix match is a valid completeness signal.
    this.expected = trimmed ? trimmed.slice(-EXPECTED_MAX) : undefined;
    this.reconcile();
  }
  push(event: TurnEvent): void {
    if (this.ended) return;
    // Bound unconsumed events AND bytes: a stalled consumer must not let a verbose/hostile
    // turn grow the buffer without limit (there is no default whole-turn timeout). The count
    // cap catches many small events; the byte cap catches a few very large payloads.
    const bytes = turnEventBytes(event);
    if (
      this.queue.length - this.head >= this.maxPending ||
      this.pendingBytes + bytes > this.maxPendingBytes
    ) {
      this.fail(elwoodError("wait_timeout", "turn produced too many unconsumed events"));
      return;
    }
    this.queue.push(event);
    this.pendingBytes += bytes;
    if (this.settled) this.armQuiet(); // new content after ready: re-arm the fallback window
    this.wake?.();
  }
  /** The rolling-window size for oracle matching: the expected text plus straddle slack. */
  private oracleWindow(): number {
    return (this.expected?.length ?? 0) + ORACLE_TAIL_SLACK;
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
        this.pendingBytes -= turnEventBytes(event);
        yield event;
      }
      // Fully caught up: reset the backing array in O(1) so consumed events are freed and the
      // array cannot grow without bound. No mid-stream splice — draining stays O(1) amortised
      // per event regardless of backlog size (splice(0, head) would re-shift the tail).
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
