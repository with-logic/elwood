/** Parked backlog selection scales with new work, not old blocked input (PRD §5.9). */
import { expect, test } from "vitest";
import { ControlAdmissions } from "../../src/core/control-queue/admission.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

const loop = { origin: { kind: "loop", loopId: "loop" } } as const;

test.each([
  "ready",
  "suspended",
])("C-LOOP-08 10,000 %s parked turn followers are checked once and a later control passes", async (readiness) => {
  let visits = 0;
  const has = ControlAdmissions.prototype.has;
  ControlAdmissions.prototype.has = function (operation) {
    visits += 1;
    return has.call(this, operation);
  };
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new ControlQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    (origin) =>
      origin.kind === "loop" ? { ready: gate.promise, run: (work) => work() } : undefined,
  );
  try {
    queue.markReady();
    const pending = [queue.send("loop", "message", undefined, loop).catch(() => undefined)];
    if (readiness === "suspended") queue.suspendReadiness();
    for (let index = 0; index < 10_000; index += 1) {
      pending.push(queue.send("follower", "message").catch(() => undefined));
    }
    const blockedVisits = visits;
    await queue.send("picker", "list_models");
    expect(writes).toEqual(["picker"]);
    queue.close();
    await Promise.all(pending);
    // Suspending readiness invalidates the initial one-entry prefix once.
    expect(blockedVisits).toBeLessThanOrEqual(10_002);
  } finally {
    queue.close();
    ControlAdmissions.prototype.has = has;
  }
});

test("C-LOOP-08 cancelling the cached reservation lets a caller cross held unadmitted loops", async () => {
  const gate = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const writes: string[] = [];
  let reserved = false;
  const queue = new ControlQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    () => {
      if (reserved) return undefined;
      reserved = true;
      return { ready: gate.promise, run: (work) => work() };
    },
  );
  queue.markReady();
  const parked = queue.send("parked", "message", undefined, {
    ...loop,
    cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
  });
  void parked.catch(() => undefined);
  queue.holdLoops();
  const held = queue.send("held", "message", undefined, loop).catch(() => undefined);
  cancel.abort();
  await expect(parked).rejects.toThrow("cancelled");
  // No reservation remains; the held loop must not become a barrier to the caller.
  const caller = queue.send("caller", "prompt");
  await caller;
  gate.resolve();
  expect(writes).toEqual(["caller"]);
  queue.close();
  await held;
});
