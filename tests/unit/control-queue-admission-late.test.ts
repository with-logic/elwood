/** Removed admissions ignore late settlements without disturbing successors (PRD §5.9, C-LOOP-08). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

const origin = { kind: "loop", loopId: "reserved" } as const;

class CountingQueue extends ControlQueue {
  drains = 0;

  protected override drain(): void {
    this.drains += 1;
    super.drain();
  }
}

test.each([
  "resolve",
  "reject",
] as const)("C-LOOP-08 late admission %s after cancellation leaves the active follower alone", async (settlement) => {
  const admission = Promise.withResolvers<void>();
  const followerWrite = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const writes: string[] = [];
  let followerSignal: AbortSignal | undefined;
  const queue = new CountingQueue(
    (input, _mode, signal) => {
      writes.push(input);
      if (input === "caller") {
        followerSignal = signal;
        return followerWrite.promise;
      }
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    () => true,
    undefined,
    undefined,
    (owner) => (owner === origin ? { ready: admission.promise, run: (work) => work() } : undefined),
  );
  queue.markReady();
  const removed = queue.send("loop", "message", undefined, {
    origin,
    cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
  });
  const follower = queue.send("caller", "prompt");
  cancel.abort();
  await expect(removed).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(writes).toEqual(["caller"]));
  const drains = queue.drains;
  if (settlement === "resolve") admission.resolve();
  else admission.reject(new Error("late rejection"));
  await admission.promise.catch(() => undefined);
  await Promise.resolve();
  expect(queue.drains).toBe(drains);
  expect(followerSignal?.aborted).toBe(false);
  followerWrite.resolve();
  await follower;
  queue.close();
});

test.each([
  "resolve",
  "reject",
] as const)("C-LOOP-08 late admission %s after close cannot restart queue draining", async (settlement) => {
  const admission = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new CountingQueue(
    (input) => {
      writes.push(input);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    () => true,
    undefined,
    undefined,
    (owner) => (owner === origin ? { ready: admission.promise, run: (work) => work() } : undefined),
  );
  queue.markReady();
  const removed = queue.send("loop", "message", undefined, { origin });
  queue.close();
  await expect(removed).rejects.toThrow("closed");
  const drains = queue.drains;
  if (settlement === "resolve") admission.resolve();
  else admission.reject(new Error("late rejection"));
  await admission.promise.catch(() => undefined);
  await Promise.resolve();
  expect(queue.drains).toBe(drains);
  expect(writes).toEqual([]);
});
