/** Queue admission preserves order outside physical dispatch (PRD §5.3/§5.9, C-LOOP-08). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { AdmissionWrapper, AdmitOperation } from "../../src/core/control-queue/types.ts";

const origin = { kind: "loop", loopId: "reserved" } as const;
const fixture = (admit: AdmitOperation, around?: AdmissionWrapper) => {
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
    around,
    admit,
  );
  queue.markReady();
  return { queue, writes };
};

test("C-LOOP-08 pending admission blocks later turn inputs but allows independent controls", async () => {
  const gate = Promise.withResolvers<void>();
  const admitted = vi.fn<AdmitOperation>((owner) =>
    owner === origin ? { ready: gate.promise, run: (work) => work() } : undefined,
  );
  const { queue, writes } = fixture(admitted);
  const pending = queue.send("loop", "message", undefined, { origin });
  const turns = ["message", "prompt", "guidance"] as const;
  const callers = turns.map((kind) => queue.send(kind, kind));
  for (const kind of ["list_models", "set_model", "login", "compact"] as const)
    await queue.runExclusive(kind, () => {
      writes.push(kind);
      return Promise.resolve();
    });
  expect(writes).toEqual(["list_models", "set_model", "login", "compact"]);
  expect(admitted.mock.calls.filter(([owner]) => owner === origin)).toHaveLength(1);
  const release = queue.holdLoops(); // Existing admission retains its place.
  gate.resolve();
  await pending;
  expect(writes.at(-1)).toBe("loop");
  for (const caller of callers) {
    queue.markReady();
    await caller;
  }
  expect(writes.slice(-3)).toEqual(turns);
  release();
  queue.close();
});

test("C-LOOP-08 admission readiness during a picker waits for physical settlement and readiness", async () => {
  const gate = Promise.withResolvers<void>();
  const picker = Promise.withResolvers<void>();
  const { queue, writes } = fixture((owner) =>
    owner === origin ? { ready: gate.promise, run: (work) => work() } : undefined,
  );
  const pending = queue.send("loop", "message", undefined, { origin });
  const picking = queue.runExclusive("list_models", () => picker.promise);
  queue.suspendReadiness();
  gate.resolve();
  await gate.promise;
  expect(writes).toEqual([]);
  picker.resolve();
  await picking;
  expect(writes).toEqual([]);
  queue.markReady();
  await pending;
  expect(writes).toEqual(["loop"]);
  queue.close();
});

test.each([
  "cancel",
  "ready cancel",
  "reject",
  "throw",
  "close",
])("C-LOOP-08 %s aborts queued admission with its error and releases followers", async (mode) => {
  const gate = Promise.withResolvers<void>();
  const picker = Promise.withResolvers<void>();
  const controller = new AbortController();
  const error = new Error(mode === "close" ? "closed" : mode);
  let signal: AbortSignal | undefined;
  const { queue, writes } = fixture((owner, lifetime) => {
    if (owner !== origin) return undefined;
    signal = lifetime;
    if (mode === "throw") throw error;
    return { ready: gate.promise, run: (work) => work() };
  });
  const pending = queue.send("loop", "message", undefined, {
    origin,
    cancel: { signal: controller.signal, error: () => error },
  });
  const rejected = expect(pending).rejects.toThrow(error.message);
  const picking = queue.runExclusive("list_models", () => picker.promise);
  void picking.catch(() => undefined);
  const follower = queue.send("caller", "prompt");
  void follower.catch(() => undefined);
  if (mode === "ready cancel") {
    gate.resolve();
    await gate.promise;
  }
  if (mode.includes("cancel")) controller.abort();
  if (mode === "reject") gate.reject(error);
  if (mode === "close") queue.close();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toEqual(error);
  expect(writes).toEqual([]);
  picker.resolve();
  if (mode === "close") {
    await expect(follower).rejects.toThrow("closed");
  } else {
    await picking;
    await follower;
    expect(writes).toEqual(["caller"]);
  }
  queue.close();
});

test("C-LOOP-08 admission composes existing cleanup once with exact signal and origin", async () => {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  let active: AbortSignal | undefined;
  let queued: AbortSignal | undefined;
  const cleanup = vi.fn<AdmissionWrapper>(async (work, signal, owner) => {
    expect(signal).toBe(active);
    expect(owner).toBe(origin);
    events.push("cleanup");
    await work();
  });
  const { queue, writes } = fixture((_owner, signal) => {
    queued = signal;
    return {
      ready: gate.promise,
      run: async (work, signal, owner) => {
        active = signal;
        expect(owner).toBe(origin);
        events.push("admission");
        await work();
        events.push("settled");
      },
    };
  }, cleanup);
  const pending = queue.send("loop", "message", undefined, { origin });
  expect(events).toEqual([]);
  gate.resolve();
  await pending;
  expect(events).toEqual(["admission", "cleanup", "settled"]);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(writes).toEqual(["loop"]);
  expect(queued?.aborted).toBe(false);
  queue.close();
  expect(active?.aborted).toBe(true);
});
