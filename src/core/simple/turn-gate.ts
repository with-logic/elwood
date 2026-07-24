/**
 * The completion gate for one ergonomic turn (PRD §5.8): a single-producer/single-consumer
 * async queue that ends a turn DETERMINISTICALLY once the transcript has caught up.
 *
 * `settle()` (on `ready`) begins completion checks and arms a `catchUpMs` failure cap. The
 * turn ends when the collected assistant text CONTAINS the Stop hook's expected text (the
 * completeness oracle), or — with no expected text — after `quietMs` of no new content; if
 * neither happens within `catchUpMs` of `ready`, it fails with `wait_timeout`. `end()`/
 * `fail()` are immediate; `drain()` finishes only once the queue is also empty, so a
 * completion racing ahead of the last buffered event never truncates the turn.
 */

import { elwoodError } from "../errors.ts";
import type { TurnEvent } from "./events.ts";

export class TurnGate {
  private readonly queue: TurnEvent[] = [];
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

  constructor(quietMs: number, catchUpMs: number) {
    this.quietMs = quietMs;
    this.catchUpMs = catchUpMs;
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
  end(): void {
    this.dispose();
    this.ended = true;
    this.wake?.();
  }
  fail(error: unknown): void {
    this.dispose();
    this.error = error;
    this.ended = true;
    this.wake?.();
  }
  /** Clear every timer (idempotent); called on end/fail and on generator teardown. */
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
      while (this.queue.length > 0) yield this.queue.shift() as TurnEvent;
      if (this.error !== undefined) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
