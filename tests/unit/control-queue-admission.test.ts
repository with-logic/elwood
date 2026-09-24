/** Parked admission retains turn order without monopolizing input (PRD §5.9). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { AdmitOperation } from "../../src/core/control-queue/types.ts";

const loop = { origin: { kind: "loop", loopId: "loop" } } as const;
function fixture(admit: AdmitOperation) {
  const writes: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      writes.push(input);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    () => true,
    undefined,
    undefined,
    admit,
  );
  queue.markReady();
  return { queue, writes };
}

test.each([
  "message",
  "prompt",
  "guidance",
] as const)("C-LOOP-08 parked loop precedes later raw %s while independent controls pass", async (kind) => {
  const gate = Promise.withResolvers<void>();
  const { queue, writes } = fixture((origin) =>
    origin.kind === "loop" ? { ready: gate.promise, run: (work) => work() } : undefined,
  );
  const pending = queue.send("loop", "message", undefined, loop);
  const caller = queue.send("caller", kind);
  for (const control of ["list_models", "set_model", "login", "compact"] as const) {
    await queue.send(control, control);
  }
  expect(writes).toEqual(["list_models", "set_model", "login", "compact"]);
  gate.resolve();
  await pending;
  queue.markReady();
  await caller;
  expect(writes.slice(-2)).toEqual(["loop", "caller"]);
  queue.close();
});

test.each([
  "waiting",
  "ready",
])("C-LOOP-08 cancelling %s admission promptly releases it without disturbing active controls", async (phase) => {
  const gate = Promise.withResolvers<void>();
  const cancelled = new AbortController();
  let signal: AbortSignal | undefined;
  const { queue, writes } = fixture((origin, abort) => {
    if (origin.kind !== "loop") return undefined;
    signal = abort;
    return { ready: gate.promise, run: (work) => work() };
  });
  const pending = queue.send("loop", "message", undefined, {
    ...loop,
    cancel: { signal: cancelled.signal, error: () => new Error("cancelled") },
  });
  void pending.catch(() => undefined);
  const pickerGate = Promise.withResolvers<void>();
  const picker = queue.runExclusive("list_models", () => pickerGate.promise);
  if (phase === "ready") {
    gate.resolve();
    await Promise.resolve();
  }
  cancelled.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(signal?.aborted).toBe(true);
  gate.resolve();
  pickerGate.resolve();
  await picker;
  await queue.send("caller", "message");
  expect(writes).toEqual(["caller"]);
  queue.close();
});

test.each([
  "throw",
  "reject",
  "close",
])("C-LOOP-08 admission %s rejects only its queued operation", async (kind) => {
  const gate = Promise.withResolvers<void>();
  const { queue, writes } = fixture(() => {
    if (kind === "throw") throw new Error("admission failed");
    return { ready: gate.promise, run: (work) => work() };
  });
  const pending = queue.send("loop", "message", undefined, loop);
  void pending.catch(() => undefined);
  if (kind === "close") queue.close();
  gate.reject(new Error("admission failed"));
  void gate.promise.catch(() => undefined);
  await expect(pending).rejects.toThrow(kind === "close" ? "closed" : "admission failed");
  expect(writes).toEqual([]);
  queue.close();
});

test("C-LOOP-08 an earlier caller hold delays admission and a later hold cannot revoke it", async () => {
  const gate = Promise.withResolvers<void>();
  const admit = vi.fn((origin) =>
    origin.kind === "loop"
      ? { ready: gate.promise, run: (work: () => Promise<void>) => work() }
      : undefined,
  );
  const { queue, writes } = fixture(admit);
  const release = queue.holdLoops();
  const pending = queue.send("loop", "message", undefined, loop);
  expect(admit).not.toHaveBeenCalled();
  await queue.send("caller", "message");
  queue.markReady();
  release();
  expect(admit).toHaveBeenCalledTimes(2); // caller, then the eligible loop
  expect(admit.mock.calls[1]![0]).toEqual(loop.origin);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  const later = queue.holdLoops();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(writes).toEqual(["caller"]);
  gate.resolve();
  await pending;
  expect(writes).toEqual(["caller", "loop"]);
  later();
  queue.close();
});
