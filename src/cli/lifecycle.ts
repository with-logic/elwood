/**
 * Single owner for CLI deadlines, SIGINT escalation, primary outcomes, and cleanup.
 * Implements PRD §12A.2/§12A.5 and C-CLI-07 through C-CLI-09/C-CLI-17.
 */

import type { Unsubscribe } from "../core/types.ts";
import { type CliFailure, cleanupAction, executionFailure } from "./lifecycle-outcome.ts";
import type { CliCleanup } from "./output/types.ts";
import type { CliSessionFacade } from "./session.ts";
import type { EffectiveRunRequest } from "./types.ts";

const MAX_TIMER_MS = 2_147_483_647;

export type CliSignalSource = { readonly onSigint: (handler: () => void) => Unsubscribe };
export type CliLifecycleClock = {
  readonly now: () => number;
  readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
};
export type LifecycleRace<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false };

const realClock: CliLifecycleClock = {
  now: Date.now,
  setTimer: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class CliLifecycle {
  private readonly request: EffectiveRunRequest;
  private readonly session: CliSessionFacade;
  private readonly signals: CliSignalSource;
  private readonly clock: CliLifecycleClock;
  private readonly startedAt: number;
  private readonly stopped: Promise<void>;
  private stop!: () => void;
  private failureValue: CliFailure | undefined;
  private consumerClosedValue = false;
  private launchStarted = false;
  private cleaning = false;
  private sigints = 0;
  private timer: unknown;
  private unbind: Unsubscribe | undefined;
  private cleanupPromise: Promise<CliCleanup> | undefined;

  constructor(
    request: EffectiveRunRequest,
    session: CliSessionFacade,
    signals: CliSignalSource,
    clock: CliLifecycleClock = realClock,
  ) {
    this.request = request;
    this.session = session;
    this.signals = signals;
    this.clock = clock;
    this.startedAt = clock.now();
    this.stopped = new Promise((resolve) => {
      this.stop = resolve;
    });
  }

  start(): void {
    this.unbind = this.signals.onSigint(() => this.onSigint());
    if (this.request.timeoutMs !== undefined) this.armDeadline(this.request.timeoutMs);
  }

  beginLaunch(): void {
    this.launchStarted = true;
  }

  get failure(): CliFailure | undefined {
    return this.failureValue;
  }

  get consumerClosed(): boolean {
    return this.consumerClosedValue;
  }

  durationMs(): number {
    return Math.max(0, Math.trunc(this.clock.now() - this.startedAt));
  }

  race<T>(operation: Promise<T>): Promise<LifecycleRace<T>> {
    return Promise.race([
      operation.then((value) => ({ completed: true as const, value })),
      this.stopped.then(() => ({ completed: false as const })),
    ]);
  }

  block(label: string): void {
    if (this.record({ code: "blocked_prompt", message: `Blocked prompt: ${label}.`, exitCode: 1 }))
      this.requestControl("kill");
  }

  agentExited(): void {
    if (this.cleaning) return;
    this.record({
      code: "agent_exited",
      message: "Agent exited before completing the turn.",
      exitCode: 1,
    });
  }

  fail(error: unknown): void {
    this.record(executionFailure(error));
  }

  closeConsumer(): void {
    if (this.failureValue !== undefined || this.consumerClosedValue) return;
    this.consumerClosedValue = true;
    this.stop();
    this.requestControl("interrupt");
  }

  cleanup(): Promise<CliCleanup> {
    this.cleanupPromise ??= this.performCleanup();
    return this.cleanupPromise;
  }

  dispose(): void {
    this.unbind?.();
    this.unbind = undefined;
    this.clearDeadline();
  }

  private record(failure: CliFailure): boolean {
    if (this.failureValue !== undefined || this.consumerClosedValue) return false;
    this.failureValue = failure;
    this.stop();
    return true;
  }

  private onSigint(): void {
    this.sigints += 1;
    if (this.sigints === 1) {
      this.record({ code: "interrupted", message: "Interrupted.", exitCode: 130 });
      this.requestControl("interrupt");
    } else this.requestControl("kill");
  }

  private requestControl(action: "interrupt" | "kill"): void {
    if (!this.launchStarted) return;
    void this.session
      .start()
      .then(() => (action === "interrupt" ? this.session.interrupt() : this.session.kill()))
      .catch(() => undefined);
  }

  private armDeadline(timeoutMs: number): void {
    const deadline = Math.min(Number.MAX_SAFE_INTEGER, this.startedAt + timeoutMs);
    const tick = () => {
      const remaining = deadline - this.clock.now();
      if (remaining > 0) {
        this.timer = this.clock.setTimer(tick, Math.min(remaining, MAX_TIMER_MS));
        return;
      }
      if (this.record({ code: "timeout", message: "Timed out.", exitCode: 124 }))
        this.requestControl("interrupt");
    };
    this.timer = this.clock.setTimer(tick, Math.min(timeoutMs, MAX_TIMER_MS));
  }

  private clearDeadline(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private async performCleanup(): Promise<CliCleanup> {
    this.cleaning = true;
    this.clearDeadline();
    const action = cleanupAction(this.request);
    try {
      await (action === "teardown" ? this.session.teardown() : this.session.close());
      return { action, status: "succeeded" };
    } catch {
      this.record({ code: "cleanup_failed", message: "Cleanup failed.", exitCode: 1 });
      return { action, status: "failed", error: "Cleanup failed." };
    }
  }
}

export { type CliFailure, cleanupAction } from "./lifecycle-outcome.ts";
