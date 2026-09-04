/** Deterministic seams shared by recurring-loop scheduler tests (PRD §5.9). */

import type {
  LoopDefinition,
  LoopSchedulerOptions,
  LoopSubmission,
} from "../../src/core/loops/scheduler-state.ts";
import type { LoopTimer, LoopTimerScheduler } from "../../src/core/loops/timers.ts";
import type { ElwoodLoopEvent } from "../../src/core/loops/types.ts";

type Task = { readonly at: number; readonly order: number; readonly run: () => void };

export class FakeLoopClock {
  nowMs = 1_800_000_000_000;
  private order = 0;
  private readonly tasks = new Map<LoopTimer, Task>();
  readonly now = (): number => this.nowMs;
  readonly schedule: LoopTimerScheduler = (run, delayMs) => {
    const timer = { cancel: () => this.tasks.delete(timer) };
    this.tasks.set(timer, { at: this.nowMs + delayMs, order: this.order++, run });
    return timer;
  };
  get pending(): number {
    return this.tasks.size;
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[1].order - right[1].order)[0];
      if (!next) break;
      this.nowMs = next[1].at;
      this.tasks.delete(next[0]);
      next[1].run();
      await flushPromises();
    }
    this.nowMs = target;
    await flushPromises();
  }
}

export class SchedulerHarness {
  readonly clock = new FakeLoopClock();
  readonly events: ElwoodLoopEvent[] = [];
  readonly writes: (readonly LoopDefinition[])[] = [];
  readonly submissions: { readonly id: string; readonly message: string }[] = [];
  nextId = 0;
  persistError: Error | undefined;
  submitError: Error | undefined;
  emitThrows = false;
  submit: LoopSubmission = (message, loopId) => {
    this.submissions.push({ id: loopId, message });
    return this.submitError ? Promise.reject(this.submitError) : Promise.resolve();
  };
  options(definitions: readonly LoopDefinition[] = []): LoopSchedulerOptions {
    return {
      definitions,
      now: this.clock.now,
      schedule: this.clock.schedule,
      createId: () => `loop-${this.nextId++}`,
      persist: (next) => {
        if (this.persistError) throw this.persistError;
        this.writes.push(next);
      },
      submit: (message, id, signal) => this.submit(message, id, signal),
      emit: (event) => {
        this.events.push(event);
        if (this.emitThrows) throw new Error("listener failed");
      },
    };
  }
}

export function fixed(
  clock: FakeLoopClock,
  overrides: Partial<LoopDefinition> = {},
): LoopDefinition {
  return {
    id: "fixed",
    message: "fixed message",
    mode: "fixed",
    intervalMs: 60_000,
    jitterMs: 0,
    createdAt: clock.nowMs,
    expiresAt: clock.nowMs + 604_800_000,
    ...overrides,
  } as LoopDefinition;
}

export function idle(
  clock: FakeLoopClock,
  overrides: Partial<LoopDefinition> = {},
): LoopDefinition {
  return {
    id: "idle",
    message: "idle message",
    mode: "idle",
    jitterMs: 0,
    createdAt: clock.nowMs,
    expiresAt: clock.nowMs + 604_800_000,
    ...overrides,
  } as LoopDefinition;
}

export async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
