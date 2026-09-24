/** Admission composes cleanup and preserves queue cost/lifetimes (PRD §5.3/§5.9). */
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

const loop = { origin: { kind: "loop", loopId: "loop" } } as const;

test("C-LOOP-08 admission observes composer cleanup and physical submission exactly once", async () => {
  const calls: string[] = [];
  const queue = new ControlQueue(
    () => {
      calls.push("write");
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    async (work) => {
      calls.push("cleanup");
      await work();
      calls.push("cleaned");
    },
    () => ({
      ready: Promise.resolve(),
      run: async (work) => {
        calls.push("admission");
        await work();
        calls.push("submitted");
      },
    }),
  );
  queue.markReady();
  await queue.send("loop", "message", undefined, loop);
  expect(calls).toEqual(["admission", "cleanup", "write", "cleaned", "submitted"]);
  queue.close();
});

test("C-LOOP-08 synchronous admission failure aborts allocated work with its rejection", async () => {
  let signal: AbortSignal | undefined;
  const queue = new ControlQueue(
    () => Promise.reject(new Error("must not write")),
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    (_origin, lifetime) => {
      signal = lifetime;
      throw new Error("admission failed");
    },
  );
  queue.markReady();
  const error = await queue
    .send("loop", "message", undefined, loop)
    .catch((reason: unknown) => reason);
  expect(error).toMatchObject({ message: "admission failed" });
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBe(error);
  queue.close();
});

test("C-LOOP-08 a not-ready held backlog without admissions keeps constant-time dispatch selection", async () => {
  let reads = 0;
  const origin = {
    get kind() {
      reads += 1;
      return "loop" as const;
    },
    loopId: "loop",
  };
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => undefined,
  );
  queue.holdLoops();
  const pending = Array.from({ length: 1000 }, () =>
    queue.send("loop", "message", undefined, { origin }).catch(() => undefined),
  );
  const checked = reads;
  queue.close();
  await Promise.all(pending);
  expect(checked).toBe(0);
});
