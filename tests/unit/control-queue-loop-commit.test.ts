/** Committed loop writes report fired before reentrant status cancellation (PRD §5.9). */
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { fixed, SchedulerHarness } from "./loop-scheduler-harness.ts";

test.each([
  "running cancellation",
  "fired close",
])("C-LOOP-08 committed loop survives %s from its observer", async (scenario) => {
  const h = new SchedulerHarness();
  const writing = Promise.withResolvers<void>();
  const order: string[] = [];
  let submission: Promise<void> | undefined;
  const queue = new ControlQueue(
    () => writing.promise,
    () => new Error("closed"),
    () => {
      order.push("running");
      scheduler.cancel("fixed");
    },
  );
  h.submit = (message, loopId, signal) => {
    submission = queue.send(message, "message", undefined, {
      origin: { kind: "loop", loopId },
      cancel: { signal, error: () => new Error("cancelled") },
      settleAfterWrite: true,
    });
    void submission.catch(() => undefined);
    return submission;
  };
  const scheduler = new LoopScheduler({
    ...h.options([fixed(h.clock)]),
    emit: (event) => {
      order.push(event.kind);
      if (scenario === "fired close" && event.kind === "fired") queue.close();
    },
  });
  try {
    queue.markReady();
    scheduler.ready();
    await h.clock.advance(60_000);
    expect(submission).toBeDefined();
    expect(order).toEqual([]);
    writing.resolve();
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(order).toEqual(
      scenario === "fired close" ? ["fired"] : ["fired", "running", "cancelled"],
    );
    await expect(submission).resolves.toBeUndefined();
  } finally {
    scheduler.pause();
    queue.close();
  }
});

test.each([
  false,
  true,
])("C-LOOP-08 prior close wins loop physical rejection=%s", async (reject) => {
  const writing = Promise.withResolvers<void>();
  const stopped = new Error("stopped");
  const abort = new AbortController();
  const started: string[] = [];
  const queue = new ControlQueue(
    () => writing.promise,
    () => stopped,
    () => started.push("running"),
  );
  queue.markReady();
  const submission = queue.send("loop", "message", undefined, {
    origin: { kind: "loop", loopId: "fixed" },
    settleAfterWrite: true,
    cancel: { signal: abort.signal, error: () => new Error("cancelled") },
  });
  const result = submission.catch((error: unknown) => error);
  queue.close();
  abort.abort();
  if (reject) writing.reject(new Error("disposed"));
  else writing.resolve();
  expect(await result).toBe(stopped);
  expect(started).toEqual([]);
});
