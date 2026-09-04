/** Fake-clock idle-loop independence coverage (PRD §5.9, C-LOOP-06/09). */

import { describe, expect, test } from "vitest";
import { IDLE_LOOP_INTERVAL_MS } from "../../src/core/loops/constants.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { flushPromises, idle, SchedulerHarness } from "./loop-scheduler-harness.ts";

describe("LoopScheduler idle cadence", () => {
  test("C-LOOP-06 rearms only the submitted origin and drains due peers", async () => {
    const harness = new SchedulerHarness();
    const definitions = [
      idle(harness.clock, { id: "b", jitterMs: 10 }),
      idle(harness.clock, { id: "a" }),
    ];
    const scheduler = new LoopScheduler(harness.options(definitions));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS + 10);
    expect(harness.submissions.map(({ id }) => id)).toEqual(["a"]);
    scheduler.ready();
    await flushPromises();
    expect(harness.submissions.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(scheduler.list().find(({ id }) => id === "a")?.state).toBe("scheduled");
  });

  test("C-LOOP-06 caller activity resets all idle clocks; other activity does not", async () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options([idle(harness.clock)]));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS - 1);
    scheduler.activity("warning");
    scheduler.activity("administration");
    scheduler.activity("loop");
    await harness.clock.advance(1);
    expect(harness.submissions).toHaveLength(1);

    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS - 1);
    scheduler.activity("caller");
    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS - 1);
    expect(harness.submissions).toHaveLength(1);
    await harness.clock.advance(1);
    expect(harness.submissions).toHaveLength(2);
  });

  test("C-LOOP-06 caller activity during a loop turn replaces its origin rearm", async () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options([idle(harness.clock)]));
    scheduler.start();
    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS);
    expect(harness.submissions).toHaveLength(1);
    scheduler.activity("caller");
    await harness.clock.advance(10_000);
    scheduler.ready();
    await harness.clock.advance(IDLE_LOOP_INTERVAL_MS - 1);
    expect(harness.submissions).toHaveLength(1);
    await harness.clock.advance(1);
    expect(harness.submissions).toHaveLength(2);
  });
});
