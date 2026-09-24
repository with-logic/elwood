/** Queue scan cost and ordering across physical-slot interleavings (PRD §5.3/§5.9). */
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

class MeasuredQueue extends ControlQueue {
  measureBacklog(): () => number {
    let reads = 0;
    for (const operation of this.queue) {
      for (const key of ["kind", "origin"] as const) {
        const value = operation[key];
        Object.defineProperty(operation, key, {
          get: () => {
            reads += 1;
            return value;
          },
        });
      }
    }
    return () => reads;
  }
}
const loop = { origin: { kind: "loop", loopId: "loop" } } as const;

test.each([
  "unready",
  "held",
])("C-LOOP-08 %s backlog is scanned once across controls queued during an active picker", async (phase) => {
  const active = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new MeasuredQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
  );
  if (phase === "held") {
    queue.markReady();
    queue.holdLoops();
  }
  const first = queue.runExclusive("list_models", () => active.promise);
  const blocked = Array.from({ length: 10_000 }, () =>
    queue
      .send("blocked", "message", undefined, phase === "held" ? loop : {})
      .catch(() => undefined),
  );
  const reads = queue.measureBacklog();
  const controls = Array.from({ length: 1000 }, (_, index) =>
    queue.send(String(index), "list_models"),
  );
  active.resolve();
  await first;
  await Promise.all(controls);
  const inspected = reads();
  queue.close();
  await Promise.all(blocked);
  expect(writes).toEqual(Array.from({ length: 1000 }, (_, index) => String(index)));
  expect(inspected).toBeLessThanOrEqual(10_000);
});

test("C-API-19 cancelling inside a scanned prefix preserves following input order", async () => {
  const cancelled = new AbortController();
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new ControlQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
  );
  const removed = queue
    .send("removed", "message", undefined, {
      cancel: { signal: cancelled.signal, error: () => new Error("cancelled") },
    })
    .catch(() => undefined);
  const remaining = queue.send("remaining", "message");
  const picker = queue.runExclusive("list_models", () => gate.promise);
  cancelled.abort();
  const caller = queue.send("caller", "prompt");
  gate.resolve();
  await picker;
  await caller;
  expect(writes).toEqual(["caller"]);
  queue.markReady();
  await remaining;
  await removed;
  expect(writes).toEqual(["caller", "remaining"]);
  queue.close();
});
