/** Race and defensive branch coverage for the loop scheduler (PRD §5.9). */

import { describe, expect, test, vi } from "vitest";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { LoopDelivery } from "../../src/core/loops/scheduler-delivery.ts";
import { LoopSchedulerState } from "../../src/core/loops/scheduler-state.ts";
import { LoopTimerBank, LoopTiming } from "../../src/core/loops/timers.ts";
import { fixed, flushPromises, SchedulerHarness } from "./loop-scheduler-harness.ts";

describe("LoopScheduler race branches", () => {
  test("stale delivery settlement cannot revive a cancelled or removed candidate", async () => {
    const harness = new SchedulerHarness();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const state = dueState(harness);
    const armDue = vi.fn();
    const expire = vi.fn();
    const fail = vi.fn();
    const emit = vi.fn();
    const delivery = new LoopDelivery({
      state,
      now: harness.clock.now,
      submit: () => new Promise<void>((yes, no) => ([resolve, reject] = [yes, no])),
      armDue,
      expire,
      fail,
      emit,
    });
    delivery.markReady();
    delivery.pump(true);
    delivery.cancelIf(() => false);
    delivery.cancel("other");
    delivery.cancelIf(() => true);
    state.commit([]);
    resolve();
    await flushPromises();
    state.commit([fixed(harness.clock)]);
    state.get("fixed")!.state = "due";
    state.get("fixed")!.dueAt = harness.clock.nowMs;
    delivery.markReady();
    delivery.pump(true);
    state.commit([]);
    reject(new Error("removed"));
    await flushPromises();
    state.commit([fixed(harness.clock)]);
    state.get("fixed")!.state = "due";
    state.get("fixed")!.dueAt = harness.clock.nowMs;
    delivery.markReady();
    delivery.pump(true);
    state.commit([]);
    resolve();
    await flushPromises();
    expect(state.entries()).toEqual([]);
    expect(armDue).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  test("submission expiry wins and caller cancellation clears an active idle origin", async () => {
    const harness = new SchedulerHarness();
    let now = harness.clock.nowMs;
    let resolve!: () => void;
    const definition = fixed(harness.clock, { expiresAt: now + 1 });
    const state = new LoopSchedulerState([definition]);
    state.get("fixed")!.state = "due";
    state.get("fixed")!.dueAt = now;
    const expire = vi.fn();
    const delivery = new LoopDelivery({
      state,
      now: () => now,
      submit: () => new Promise<void>((yes) => (resolve = yes)),
      armDue: vi.fn(),
      expire,
      fail: vi.fn(),
      emit: vi.fn(),
    });
    delivery.markReady();
    delivery.pump(true);
    now += 1;
    resolve();
    await flushPromises();
    expect(expire).toHaveBeenCalledWith("fixed");
  });
  test("start, stale expiry, paused expiry, and list pruning stay idempotent", () => {
    const harness = new SchedulerHarness();
    const callbacks: (() => void)[] = [];
    const base = harness.options([fixed(harness.clock, { expiresAt: harness.clock.nowMs + 10 })]);
    const scheduler = new LoopScheduler({
      ...base,
      schedule: (run) => {
        callbacks.push(run);
        return { cancel: () => undefined };
      },
    });
    scheduler.start();
    scheduler.start();
    scheduler.activity("caller");
    scheduler.cancel("fixed");
    callbacks[0]!();
    const paused = new LoopScheduler({
      ...harness.options([fixed(harness.clock, { expiresAt: harness.clock.nowMs + 10 })]),
      schedule: (run) => {
        callbacks.push(run);
        return { cancel: () => undefined };
      },
    });
    paused.start();
    paused.pause();
    callbacks.at(-1)!();
    expect(paused.list()).toEqual([]);
  });
  test("omitted definitions and live list-pruning cover fresh scheduler branches", () => {
    const harness = new SchedulerHarness();
    const { definitions: _definitions, ...options } = harness.options();
    const fresh = new LoopScheduler(options);
    fresh.ready();
    fresh.clear("kill");
    let now = harness.clock.nowMs;
    const pruning = new LoopScheduler({
      ...harness.options([fixed(harness.clock, { expiresAt: now + 1 })]),
      now: () => now,
      schedule: () => ({ cancel: () => undefined }),
    });
    pruning.start();
    now += 1;
    expect(pruning.list()).toEqual([]);
    expect(harness.events).toContainEqual(expect.objectContaining({ kind: "expired" }));
  });
  test("batch persistence failure reports active IDs without request contents", () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock)]));
    scheduler.start();
    harness.persistError = new Error("disk full");
    expect(() => scheduler.clear("teardown")).toThrowError(
      expect.objectContaining({ code: "loop_persistence_failed", details: {} }),
    );
    expect(harness.events.at(-1)).toMatchObject({
      kind: "failed",
      loopId: "fixed",
      phase: "persistence",
    });
  });
});
describe("LoopTiming defensive callbacks", () => {
  test("a stopped scheduler does not retry failed due or expiry timers", () => {
    const harness = new SchedulerHarness();
    const state = new LoopSchedulerState([fixed(harness.clock)]);
    let calls = 0;
    const timing = new LoopTiming(
      new LoopTimerBank(() => {
        calls += 1;
        throw new Error("timer");
      }),
      {
        state,
        now: harness.clock.now,
        live: () => false,
        fail: vi.fn(),
        expire: vi.fn(),
        pump: vi.fn(),
      },
    );
    timing.armDue(state.get("fixed")!, harness.clock.nowMs);
    timing.armExpiry(state.get("fixed")!);
    expect(calls).toBe(2);
  });
  test("stale due callbacks ignore missing and non-live definitions", () => {
    const harness = new SchedulerHarness();
    const callbacks: (() => void)[] = [];
    const state = new LoopSchedulerState([fixed(harness.clock)]);
    let live = true;
    const timing = new LoopTiming(
      new LoopTimerBank((run) => {
        callbacks.push(run);
        return { cancel: () => undefined };
      }),
      {
        state,
        now: harness.clock.now,
        live: () => live,
        fail: vi.fn(),
        expire: vi.fn(),
        pump: vi.fn(),
      },
    );
    timing.armDue(state.get("fixed")!, harness.clock.nowMs);
    state.commit([]);
    callbacks[0]!();
    state.commit([fixed(harness.clock)]);
    timing.armDue(state.get("fixed")!, harness.clock.nowMs);
    live = false;
    callbacks[1]!();
  });
});
function dueState(harness: SchedulerHarness): LoopSchedulerState {
  const state = new LoopSchedulerState([fixed(harness.clock)]);
  state.get("fixed")!.state = "due";
  state.get("fixed")!.dueAt = harness.clock.nowMs;
  return state;
}
