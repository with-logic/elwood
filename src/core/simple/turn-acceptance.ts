/**
 * Recovers an ergonomic turn whose deadline-released paste was swallowed by a
 * cold-start composer placeholder. Implements PRD §5.3/§5.8 and C-API-48.
 */

import { elwoodError } from "../errors.ts";

const maxReplayAttempts = 2;

export type TurnAcceptanceIo = {
  readonly replay: (signal: AbortSignal) => Promise<void>;
  readonly acceptReady: () => void;
  readonly fail: (error: unknown) => void;
};

export class TurnAcceptance {
  private readonly quietMs: number;
  private readonly io: TurnAcceptanceIo;
  private accepted = false;
  private pendingReady = false;
  private replayAttempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancellation = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(quietMs: number, io: TurnAcceptanceIo) {
    this.quietMs = quietMs;
    this.io = io;
  }

  /**
   * Disarm as soon as `settled` settles EITHER way, then run `onSuccess` for a successful
   * settle only. Recovery must not outlive its turn (C-API-58): once the turn is over there
   * is nothing to recover, and a surviving replay would re-submit the prompt into whatever
   * runs next. Hanging this off the turn's own settle signal — rather than off each failure
   * path — is what makes an early-returning path (a rejected submission) disarm too.
   */
  disarmOnSettle(settled: Promise<void>, onSuccess: () => void): void {
    const disarm = () => this.dispose();
    settled.then(() => {
      disarm();
      onSuccess();
    }, disarm);
  }

  /** Hold the serializer slot and images until every cancelled replay finishes cleanup. */
  async quiesce(): Promise<void> {
    await Promise.all(this.inFlight);
  }

  accept(): void {
    if (this.accepted) return;
    this.accepted = true;
    this.cancelTimer();
    if (this.pendingReady) this.io.acceptReady();
  }

  running(): void {
    this.pendingReady = false;
    if (this.timer) this.armWatchdog();
  }

  ready(): boolean {
    if (this.accepted) return true;
    this.pendingReady = true;
    this.armWatchdog();
    return false;
  }

  dispose(): void {
    this.accepted = true;
    this.cancelTimer();
    this.cancellation.abort();
  }

  private recover(): void {
    this.timer = undefined;
    if (this.replayAttempts >= maxReplayAttempts) {
      this.io.fail(elwoodError("wait_timeout", "turn submission was not accepted"));
      return;
    }
    this.pendingReady = false;
    this.replayAttempts += 1;
    const write = this.io.replay(this.cancellation.signal).then(
      () => this.ensureWatchdog(),
      (error) => {
        this.cancelTimer();
        if (!this.cancellation.signal.aborted) this.io.fail(error);
      },
    );
    this.inFlight.add(write);
    void write.then(() => this.inFlight.delete(write));
  }

  private armWatchdog(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => this.recover(), this.quietMs);
    this.timer.unref?.();
  }

  private ensureWatchdog(): void {
    if (this.accepted || this.timer) return;
    this.armWatchdog();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
