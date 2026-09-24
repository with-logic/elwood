/** Physical loop completion releases capacity before reentrant fired handlers (C-API-58). */
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { fixed, SchedulerHarness } from "./loop-scheduler-harness.ts";

test("C-API-58 fired handler can reuse the settled loop's budget while ordering remains held", async () => {
  const harness = new SchedulerHarness();
  const physical = Promise.withResolvers<void>();
  const order: string[] = [];
  const queue = new ControlQueue(
    (text) => {
      order.push(text);
      return text === "fixed message" ? physical.promise : Promise.resolve();
    },
    () => new Error("closed"),
    (origin) => {
      if (origin.kind === "loop") order.push("running");
    },
  );
  harness.submit = (message, loopId, signal) =>
    queue.send(message, "message", undefined, {
      origin: { kind: "loop", loopId },
      settleAfterWrite: true,
      cancel: { signal, error: () => new Error("cancelled") },
    });
  let successor: Promise<unknown> | undefined;
  const scheduler = new LoopScheduler({
    ...harness.options([fixed(harness.clock)]),
    emit: (event) => {
      if (event.kind === "fired") {
        order.push("fired");
        successor = queue.send("successor", "prompt").then(
          () => "written",
          (error: unknown) => error,
        );
      }
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    queue.markReady();
    scheduler.ready();
    await harness.clock.advance(60_000);
    for (let index = 0; index < 1023; index++)
      pending.push(queue.send("waiting", "message").catch((error: unknown) => error));
    physical.resolve();
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    expect(await successor).toBe("written");
    expect(order).toEqual(["fixed message", "fired", "running", "successor"]);
    // The later ordering settlement must not subtract the loop reservation twice.
    await expect(queue.send("x".repeat(8 * 1_024 * 1_024 + 1), "prompt")).rejects.toMatchObject({
      code: "input_queue_full",
    });
  } finally {
    scheduler.pause();
    queue.close();
    physical.resolve();
    await Promise.all(pending);
  }
});
