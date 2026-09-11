/**
 * Race coverage for the loop scheduler (PRD §5.9), driven only through its public surface
 * and the injectable clock/timer seam: a submission settling AFTER its loop was cancelled or
 * expired, and timers that a non-cancelling scheduler seam fires late (the seam's contract
 * allows it), which every timer callback must tolerate.
 */

import { describe, expect, test } from "vitest";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import type { LoopSchedulerOptions } from "../../src/core/loops/scheduler-state.ts";
import { fixed, flushPromises, SchedulerHarness } from "./loop-scheduler-harness.ts";

/** A seam whose `cancel` is a no-op, so a cancelled timer can still be fired by the test. */
function nonCancelling(harness: SchedulerHarness, definitions = [fixed(harness.clock)]) {
  const callbacks: (() => void)[] = [];
  const options: LoopSchedulerOptions = {
    ...harness.options(definitions),
    schedule: (run) => {
      callbacks.push(run);
      return { cancel: () => undefined };
    },
  };
  return { scheduler: new LoopScheduler(options), callbacks };
}

describe("LoopScheduler race branches", () => {
  test("C-LOOP-17 a submission settling AFTER its loop was cancelled cannot revive it", async () => {
    const harness = new SchedulerHarness();
    const settle: { resolve: () => void; reject: (error: Error) => void }[] = [];
    harness.submit = () =>
      new Promise<void>((resolve, reject) => {
        settle.push({ resolve, reject });
      });
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    scheduler.ready();
    const first = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "one" });
    await harness.clock.advance(60_000 + first.jitterMs); // due → submitted (write pending)
    expect(settle).toHaveLength(1);
    scheduler.cancel(first.id); // the candidate is dropped while the write is in flight
    settle[0]?.resolve(); // a STALE resolve: no `fired`, no re-arm
    await flushPromises();
    expect(harness.events.map(({ kind }) => kind)).toEqual(["created", "cancelled"]);
    expect(harness.clock.pending).toBe(0);
    // A stale REJECTION is equally inert: no `failed`, no retry.
    const second = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "two" });
    await harness.clock.advance(60_000 + second.jitterMs);
    scheduler.cancel(second.id);
    settle[1]?.reject(new Error("late"));
    await flushPromises();
    expect(harness.events.filter(({ kind }) => kind === "failed")).toEqual([]);
    expect(harness.clock.pending).toBe(0);
    expect(scheduler.list()).toEqual([]);
  });

  test("C-LOOP-13 a submission settling after the loop's expiry expires it instead of firing", async () => {
    const harness = new SchedulerHarness();
    let resolve!: () => void;
    harness.submit = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    const expiresAt = harness.clock.nowMs + 60_001;
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock, { expiresAt })]));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(60_000); // due (jitter 0) → write pending
    harness.clock.nowMs = expiresAt; // the wall clock passes expiry while the write is in flight
    resolve();
    await flushPromises();
    expect(harness.events.filter(({ kind }) => kind === "fired")).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({ kind: "expired", loopId: "fixed" });
    expect(scheduler.list()).toEqual([]);
  });

  test("C-LOOP-13 a due loop that expired while the session was busy expires at the next pump", async () => {
    const harness = new SchedulerHarness();
    const expiresAt = harness.clock.nowMs + 60_001;
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock, { expiresAt })]));
    scheduler.start();
    scheduler.ready();
    scheduler.running(); // a caller turn holds delivery
    await harness.clock.advance(60_000); // due, but not ready → held
    harness.clock.nowMs = expiresAt;
    scheduler.ready(); // the pump finds the head loop already expired
    expect(harness.submissions).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({ kind: "expired", loopId: "fixed" });
  });

  test("C-LOOP-08 caller activity leaves an in-flight or just-fired FIXED loop alone", async () => {
    // Caller activity only resets IDLE loops: a fixed loop mid-write is not aborted, and once
    // fired it stays the active origin without being cleared or rescheduled early.
    const harness = new SchedulerHarness();
    let resolve!: () => void;
    let aborted = false;
    harness.submit = (_message, _id, signal) =>
      new Promise<void>((done) => {
        signal.addEventListener("abort", () => (aborted = true), { once: true });
        resolve = done;
      });
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock)]));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(60_000); // due → write pending
    scheduler.activity("caller"); // a fixed candidate is not an idle loop → untouched
    expect(aborted).toBe(false);
    resolve();
    await flushPromises();
    expect(harness.events.at(-1)).toMatchObject({ kind: "fired", loopId: "fixed" });
    scheduler.activity("caller"); // the fired fixed loop stays the active origin
    scheduler.ready();
    expect(scheduler.list().map(({ state }) => state)).toEqual(["scheduled"]);
  });

  test("timers a non-cancelling seam fires after cancellation are ignored", () => {
    const harness = new SchedulerHarness();
    const { scheduler, callbacks } = nonCancelling(harness);
    scheduler.start();
    scheduler.start(); // idempotent: no second expiry timer
    scheduler.ready();
    expect(callbacks).toHaveLength(2); // [expiry, due]
    scheduler.activity("caller"); // a fixed loop is untouched by caller activity
    scheduler.cancel("fixed");
    for (const run of callbacks.splice(0)) run(); // stale expiry + stale due
    expect(harness.events.map(({ kind }) => kind)).toEqual(["cancelled"]);
    expect(scheduler.list()).toEqual([]);
  });

  test("timers a non-cancelling seam fires after pause neither emit nor re-arm", () => {
    const harness = new SchedulerHarness();
    const { scheduler, callbacks } = nonCancelling(harness);
    scheduler.start();
    scheduler.ready();
    scheduler.pause();
    const [expiry, due] = callbacks.splice(0);
    due?.(); // a stale due on a paused scheduler leaves the loop waiting
    expect(scheduler.list().map(({ state }) => state)).toEqual(["waiting"]);
    expiry?.(); // a stale expiry still retires the loop but emits nothing while paused
    expect(scheduler.list()).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(callbacks).toEqual([]);
  });

  test("omitted definitions and live list-pruning cover fresh scheduler branches", () => {
    const harness = new SchedulerHarness();
    const { definitions: _definitions, ...options } = harness.options();
    const fresh = new LoopScheduler(options);
    fresh.ready();
    fresh.clear("kill");
    expect(harness.writes).toEqual([]); // nothing to persist for an empty scheduler
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

  test("C-LOOP-05 a timer seam that throws fails the loop once and re-arms exactly once", () => {
    const harness = new SchedulerHarness();
    let arms = 0;
    const scheduler = new LoopScheduler({
      ...harness.options([fixed(harness.clock)]),
      schedule: () => {
        arms += 1;
        throw new Error("no timers");
      },
    });
    scheduler.start(); // expiry: arm, fail, one retry, fail → 2 attempts, no infinite loop
    expect(arms).toBe(2);
    scheduler.ready(); // due: the same single re-arm from a fresh anchor, then give up
    expect(arms).toBe(4);
    expect(harness.events.filter(({ kind }) => kind === "failed")).toHaveLength(4);
    expect(scheduler.list().map(({ state }) => state)).toEqual(["waiting"]);
  });
});
