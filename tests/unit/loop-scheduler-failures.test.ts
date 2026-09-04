/** Fake-clock scheduler failure and capacity coverage (PRD §5.9). */

import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { MAX_ACTIVE_LOOPS } from "../../src/core/loops/constants.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { fixed, flushPromises, SchedulerHarness } from "./loop-scheduler-harness.ts";

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ElwoodError) return error.code;
    throw error;
  }
  throw new Error("Expected ElwoodError");
}

describe("LoopScheduler failures", () => {
  test("C-LOOP-04 rejects the fifty-first loop without mutation", () => {
    const harness = new SchedulerHarness();
    const definitions = Array.from({ length: MAX_ACTIVE_LOOPS }, (_, index) =>
      fixed(harness.clock, { id: `loop-${index}` }),
    );
    const scheduler = new LoopScheduler(harness.options(definitions));
    scheduler.start();
    expect(errorCode(() => scheduler.create({ mode: "idle", message: "overflow" }))).toBe(
      "loop_limit_reached",
    );
    expect(scheduler.list()).toHaveLength(MAX_ACTIVE_LOOPS);
    expect(harness.writes).toEqual([]);
  });

  test("C-LOOP-10 persistence failure leaves state unchanged and emits redacted failure", () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    harness.persistError = new Error("disk full: private prompt");
    expect(errorCode(() => scheduler.create({ mode: "idle", message: "private prompt" }))).toBe(
      "loop_persistence_failed",
    );
    expect(scheduler.list()).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain("private prompt");
  });

  test("C-LOOP-10 submission failure rearms live and pauses after shutdown", async () => {
    const harness = new SchedulerHarness();
    harness.submitError = new Error("terminal failed");
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    scheduler.ready();
    const loop = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "secret" });
    await harness.clock.advance(60_000 + loop.jitterMs);
    await flushPromises();
    expect(scheduler.list()[0]).toMatchObject({ state: "scheduled" });
    expect(harness.events.at(-1)).toMatchObject({
      kind: "failed",
      loopId: loop.id,
      phase: "submission",
      code: "loop_submission_failed",
    });
    expect(JSON.stringify(harness.events)).not.toContain("secret");
    scheduler.pause();
    expect(scheduler.list()[0]?.state).toBe("waiting");
  });

  test("C-LOOP-16 throwing event listeners cannot stop scheduling", async () => {
    const harness = new SchedulerHarness();
    harness.emitThrows = true;
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    scheduler.ready();
    const loop = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "safe" });
    await harness.clock.advance(60_000 + loop.jitterMs);
    await flushPromises();
    expect(harness.submissions).toHaveLength(1);
  });

  test("C-LOOP-10 a one-shot scheduling failure emits and rearms from fresh time", () => {
    const harness = new SchedulerHarness();
    const base = harness.options();
    let calls = 0;
    const scheduler = new LoopScheduler({
      ...base,
      schedule: (run, delay) => {
        calls += 1;
        if (calls === 2) throw new Error("timer unavailable");
        return harness.clock.schedule(run, delay);
      },
    });
    scheduler.start();
    scheduler.ready();
    const loop = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "safe" });
    expect(loop.state).toBe("scheduled");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: "failed", phase: "scheduling" }),
    );
  });

  test("C-LOOP-10 expiry timer scheduling failures are contained and reported", () => {
    const harness = new SchedulerHarness();
    const base = harness.options();
    let first = true;
    const scheduler = new LoopScheduler({
      ...base,
      schedule: (run, delay) => {
        if (first) {
          first = false;
          throw new Error("expiry timer unavailable");
        }
        return harness.clock.schedule(run, delay);
      },
    });
    scheduler.start();
    const loop = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "safe" });
    expect(loop.state).toBe("scheduled");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: "failed", phase: "scheduling" }),
    );
  });

  test("C-LOOP-10 persistence failures preserve active definitions and snapshots", () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options([fixed(harness.clock)]));
    scheduler.start();
    harness.persistError = new Error("disk full");
    expect(errorCode(() => scheduler.cancel("fixed"))).toBe("loop_persistence_failed");
    expect(scheduler.list()).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      kind: "failed",
      loopId: "fixed",
      phase: "persistence",
      snapshot: { id: "fixed" },
    });
  });
});
