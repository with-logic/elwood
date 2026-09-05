/**
 * Recovers an ergonomic turn whose deadline-released paste was swallowed by a
 * cold-start composer placeholder. Implements PRD §5.3/§5.8 and C-API-48.
 */

import { elwoodError } from "../errors.ts";

const maxReplayAttempts = 2;

export type TurnAcceptanceIo = {
  readonly replay: () => Promise<void>;
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

  constructor(quietMs: number, io: TurnAcceptanceIo) {
    this.quietMs = quietMs;
    this.io = io;
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
  }

  private recover(): void {
    this.timer = undefined;
    if (this.replayAttempts >= maxReplayAttempts) {
      this.io.fail(elwoodError("wait_timeout", "turn submission was not accepted"));
      return;
    }
    this.pendingReady = false;
    this.replayAttempts += 1;
    void this.io.replay().then(
      () => this.ensureWatchdog(),
      (error) => {
        this.cancelTimer();
        this.io.fail(error);
      },
    );
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
