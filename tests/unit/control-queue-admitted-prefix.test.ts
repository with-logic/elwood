/** Cached position is not itself an admission barrier (PRD §5.3/§5.9, C-LOOP-08). */
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

test("C-LOOP-08 only the actual reservation blocks callers behind a cached held-loop prefix", async () => {
  const gate = Promise.withResolvers<void>();
  const origin = { kind: "loop", loopId: "reserved" } as const;
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
    (owner) => (owner === origin ? { ready: gate.promise, run: (work) => work() } : undefined),
  );
  const release = queue.holdLoops();
  const held = queue.send("held", "message", undefined, {
    origin: { kind: "loop", loopId: "held" },
  });
  const compact = queue.send("compact", "compact");
  const earlier = queue.send("earlier", "message");
  // Admission starts before a new hold; the held loop above remains unadmitted.
  release();
  const reserved = queue.send("reserved", "list_models", undefined, { origin });
  const hold = queue.holdLoops();
  const later = queue.send("later", "prompt");
  queue.markReady();
  await compact;
  expect(writes).toEqual(["compact", "earlier"]);
  await earlier;
  expect(writes).not.toContain("later");
  gate.resolve();
  await reserved;
  await later;
  expect(writes).toEqual(["compact", "earlier", "reserved", "later"]);
  hold();
  queue.markReady();
  await held;
  expect(writes.at(-1)).toBe("held");
  queue.close();
});

test("C-LOOP-08 a ready independent reservation crosses an earlier waiting reservation", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
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
    (owner) =>
      owner.kind === "loop"
        ? {
            ready: owner.loopId === "first" ? first.promise : second.promise,
            run: (work) => work(),
          }
        : undefined,
  );
  queue.markReady();
  const pending = queue.send("first", "message", undefined, {
    origin: { kind: "loop", loopId: "first" },
  });
  const picker = queue.send("second", "list_models", undefined, {
    origin: { kind: "loop", loopId: "second" },
  });
  const caller = queue.send("caller", "prompt");
  second.resolve();
  await picker;
  expect(writes).toEqual(["second"]);
  first.resolve();
  await pending;
  await caller;
  expect(writes).toEqual(["second", "first", "caller"]);
  queue.close();
});

test("C-LOOP-08 a burst of synchronously rejected admissions cannot overflow queue draining", async () => {
  const picker = Promise.withResolvers<void>();
  const error = new Error("admission failed");
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    (owner) => {
      if (owner.kind === "loop") throw error;
      return undefined;
    },
  );
  const active = queue.runExclusive("list_models", () => picker.promise);
  const rejected = Array.from({ length: 1_022 }, () =>
    queue
      .send("loop", "prompt", undefined, { origin: { kind: "loop", loopId: "failed" } })
      .catch((failure: unknown) => failure),
  );
  const follower = queue.send("caller", "prompt");
  picker.resolve();
  await active;
  const failures = await Promise.all(rejected);
  expect(failures).toHaveLength(1_022);
  expect(failures.every((failure) => failure === error)).toBe(true);
  await expect(follower).resolves.toBeUndefined();
  queue.close();
});
