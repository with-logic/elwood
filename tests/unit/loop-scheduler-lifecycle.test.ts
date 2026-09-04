/** Fake-clock scheduler cancellation, expiry, and cleanup coverage (PRD §5.9). */

import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { fixed, flushPromises, idle, SchedulerHarness } from "./loop-scheduler-harness.ts";

describe("LoopScheduler lifecycle", () => {
  test("C-LOOP-13 expires live and restored definitions at the wall-clock boundary", async () => {
    const harness = new SchedulerHarness();
    const expiresAt = harness.clock.nowMs + 100;
    const scheduler = new LoopScheduler(
      harness.options([fixed(harness.clock, { id: "old", expiresAt })]),
    );
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(100);
    expect(scheduler.list()).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({ kind: "expired", loopId: "old", at: expiresAt });

    const restored = new LoopScheduler(
      harness.options([idle(harness.clock, { id: "expired", expiresAt: harness.clock.nowMs })]),
    );
    restored.start();
    restored.ready();
    expect(restored.list()).toEqual([]);
    expect(harness.events.filter(({ kind }) => kind === "expired")).toHaveLength(1);
  });

  test("C-LOOP-17 cancellation removes waiting, due, queued, and submitted loops", async () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    const waiting = scheduler.create({ mode: "idle", message: "waiting" });
    scheduler.cancel(waiting.id);
    scheduler.ready();
    const due = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "due" });
    scheduler.running();
    await harness.clock.advance(60_000 + due.jitterMs);
    scheduler.cancel(due.id);
    scheduler.ready();
    const submitted = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "sent" });
    await harness.clock.advance(60_000 + submitted.jitterMs);
    await flushPromises();
    scheduler.cancel(submitted.id);
    expect(scheduler.list()).toEqual([]);
    expect(harness.events.filter(({ kind }) => kind === "cancelled")).toHaveLength(3);
  });

  test("C-LOOP-14 pause preserves definitions and clears all runtime timers", () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(
      harness.options([fixed(harness.clock), idle(harness.clock)]),
    );
    scheduler.start();
    scheduler.ready();
    expect(harness.clock.pending).toBe(4);
    scheduler.pause();
    expect(harness.clock.pending).toBe(0);
    expect(scheduler.list().map(({ state }) => state)).toEqual(["waiting", "waiting"]);
  });

  test("C-LOOP-18 unknown cancellation is explicit", () => {
    const scheduler = new LoopScheduler(new SchedulerHarness().options());
    expect(() => scheduler.cancel("missing")).toThrow(ElwoodError);
    try {
      scheduler.cancel("missing");
    } catch (error) {
      expect((error as ElwoodError).code).toBe("loop_not_found");
    }
  });

  test("C-LOOP-17 queued cancellation aborts submission and releases the next due peer", async () => {
    const harness = new SchedulerHarness();
    harness.submit = (message, id, signal) =>
      new Promise<void>((_resolve, reject) => {
        harness.submissions.push({ id, message });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const scheduler = new LoopScheduler(
      harness.options([fixed(harness.clock, { id: "a" }), fixed(harness.clock, { id: "b" })]),
    );
    scheduler.start();
    scheduler.ready();
    scheduler.running();
    await harness.clock.advance(60_000);
    scheduler.ready();
    expect(harness.submissions.map(({ id }) => id)).toEqual(["a"]);
    scheduler.cancel("a");
    await flushPromises();
    expect(harness.submissions.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  test("C-LOOP-14 clear persists empty, emits reasons, and makes scheduler terminal", () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(
      harness.options([fixed(harness.clock), idle(harness.clock)]),
    );
    scheduler.start();
    scheduler.start();
    scheduler.clear("kill");
    expect(harness.writes.at(-1)).toEqual([]);
    expect(harness.events.filter(({ kind }) => kind === "cancelled")).toHaveLength(2);
    expect(() => scheduler.create({ mode: "idle", message: "late" })).toThrow(ElwoodError);

    const empty = new SchedulerHarness();
    new LoopScheduler(empty.options()).clear("teardown");
    expect(empty.writes).toEqual([]);
  });

  test("C-LOOP-13 expiry wins when submission settles at the boundary", async () => {
    const harness = new SchedulerHarness();
    let resolve!: () => void;
    harness.submit = (message, id) => {
      harness.submissions.push({ id, message });
      return new Promise<void>((done) => (resolve = done));
    };
    const expiresAt = harness.clock.nowMs + 60_001;
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock, { expiresAt })]));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(60_000);
    harness.clock.nowMs = expiresAt;
    resolve();
    await flushPromises();
    expect(scheduler.list()).toEqual([]);
    expect(harness.events.some(({ kind }) => kind === "fired")).toBe(false);
    expect(harness.events.at(-1)).toMatchObject({ kind: "expired", loopId: "fixed" });
  });
});
