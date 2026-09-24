/** Ergonomic ownership defers only loop input (PRD §5.8/§5.9, C-API-48/C-LOOP-08). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

const loop = { origin: { kind: "loop", loopId: "loop" } } as const;
const fixture = () => {
  const writes: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (input === "reject") return Promise.reject(new Error("write failed"));
      writes.push(input);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
  );
  return { queue, writes };
};

test("C-LOOP-08 nested holds preserve loop order while caller recovery passes the loop head", async () => {
  const { queue, writes } = fixture();
  const release = queue.holdLoops();
  const nested = queue.holdLoops();
  const pending = queue.send("loop", "message", undefined, loop);
  const later = queue.send("later loop", "message", undefined, loop);
  await queue.send("prompt", "prompt");
  queue.markReady();
  await queue.send("caller", "message");
  queue.markReady();
  await queue.send("recovery", "message");
  await queue.runExclusive("list_models", () => {
    writes.push("picker");
    return Promise.resolve();
  });
  release();
  release();
  queue.markReady();
  expect(writes).toEqual(["prompt", "caller", "recovery", "picker"]);
  nested();
  await pending;
  expect(writes).toEqual(["prompt", "caller", "recovery", "picker", "loop"]);
  queue.markReady();
  await later;
  expect(writes).toEqual(["prompt", "caller", "recovery", "picker", "loop", "later loop"]);
  queue.close();
});

test("C-LOOP-08 failed caller input preserves the loop hold until its owner releases", async () => {
  const { queue, writes } = fixture();
  queue.markReady();
  const release = queue.holdLoops();
  const pending = queue.send("loop", "message", undefined, loop);
  await expect(queue.send("reject", "message")).rejects.toThrow("write failed");
  expect(writes).toEqual([]);
  release();
  await pending;
  expect(writes).toEqual(["loop"]);
  queue.close();
});

test("C-LOOP-08 cancellation and close discard held loops before a later release", async () => {
  const { queue, writes } = fixture();
  const release = queue.holdLoops();
  queue.markReady();
  const controller = new AbortController();
  const cancelled = queue.send("cancel", "message", undefined, {
    ...loop,
    cancel: { signal: controller.signal, error: () => new Error("cancelled") },
  });
  const rejected = vi.fn();
  void cancelled.catch(rejected);
  controller.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  const closed = queue.send("close", "message", undefined, loop);
  void closed.catch(rejected);
  queue.close();
  await expect(closed).rejects.toThrow("closed");
  release();
  release();
  expect(rejected).toHaveBeenCalledTimes(2);
  expect(writes).toEqual([]);
});
