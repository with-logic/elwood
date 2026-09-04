/** Fake-clock fixed-loop scheduler coverage (PRD §5.9, C-LOOP-05/07/08/09). */

import { describe, expect, test } from "vitest";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { flushPromises, SchedulerHarness } from "./loop-scheduler-harness.ts";

describe("LoopScheduler fixed cadence", () => {
  test("C-LOOP-05 delays first fire and re-anchors after committed submission", async () => {
    const harness = new SchedulerHarness();
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    scheduler.ready();
    const created = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "deploy" });
    expect(created.state).toBe("scheduled");

    await harness.clock.advance(60_000 + created.jitterMs - 1);
    expect(harness.submissions).toEqual([]);
    await harness.clock.advance(1);
    expect(harness.submissions).toEqual([{ id: created.id, message: "deploy" }]);
    await flushPromises();
    expect(scheduler.list()[0]?.state).toBe("submitted");

    await harness.clock.advance(120_000 + created.jitterMs);
    expect(harness.submissions).toHaveLength(1);
    expect(scheduler.list()[0]?.state).toBe("due");
    scheduler.ready();
    await flushPromises();
    expect(harness.submissions).toHaveLength(2);
  });

  test("C-LOOP-09 orders equal due times by ID and coalesces missed occurrences", async () => {
    const harness = new SchedulerHarness();
    harness.nextId = 10;
    const scheduler = new LoopScheduler(harness.options());
    scheduler.start();
    scheduler.ready();
    const laterId = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "b" });
    harness.nextId = 1;
    const earlierId = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "a" });
    await harness.clock.advance(60_000 + Math.max(laterId.jitterMs, earlierId.jitterMs));
    await flushPromises();
    const first = [laterId, earlierId]
      .map(({ id, jitterMs }) => ({ id, jitterMs }))
      .sort((a, b) => a.jitterMs - b.jitterMs || a.id.localeCompare(b.id))[0]!.id;
    expect(harness.submissions[0]?.id).toBe(first);
    expect(harness.submissions).toHaveLength(1);
    scheduler.ready();
    await flushPromises();
    expect(harness.submissions).toHaveLength(2);
  });
});
