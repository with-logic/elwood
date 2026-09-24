/** Admission bounds retain physical-write ownership (PRD §5.3, C-API-58). */
import { expect, test, vi } from "vitest";
import { inputQueueLimits } from "../../src/core/control-queue/budget.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

function fixture(submit = vi.fn(async () => undefined)) {
  const stopped = new Error("stopped");
  const queue = new ControlQueue(
    submit,
    () => stopped,
    () => undefined,
  );
  return { queue, submit, stopped };
}
const observe = (promise: Promise<void>) =>
  promise.then(
    () => "written",
    (error: unknown) => error,
  );

for (const limit of ["count", "bytes"] as const) {
  test(`C-API-58 bounds suspended ${limit} before attachment or admission`, async () => {
    const { queue, submit } = fixture();
    const attach = vi.fn(async () => undefined);
    const input = limit === "bytes" ? "é".repeat(inputQueueLimits.bytes / 2) : "";
    const count = limit === "bytes" ? 1 : inputQueueLimits.operations;
    const waiting = Array.from({ length: count }, () => observe(queue.send(input, "message")));
    let failure: unknown;
    const overflow = queue.send("x", "message", attach).catch((error: unknown) => {
      failure = error;
    });
    try {
      await Promise.resolve();
      expect(failure).toMatchObject({ code: "input_queue_full", details: {} });
      expect(attach).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      queue.close();
      await Promise.all([...waiting, overflow]);
    }
  });
}

test("C-API-58 rejects a single oversized input without retaining capacity", async () => {
  const { queue, submit } = fixture();
  let failure: unknown;
  const oversized = queue
    .send("x".repeat(inputQueueLimits.bytes + 1), "message")
    .catch((error: unknown) => {
      failure = error;
    });
  try {
    await Promise.resolve();
    expect(failure).toMatchObject({ code: "input_queue_full" });
    await queue.send("usable", "prompt");
    expect(submit).toHaveBeenCalledWith(
      "usable",
      "pasted_input",
      expect.any(AbortSignal),
      undefined,
    );
  } finally {
    queue.close();
    await oversized;
  }
});

test("C-API-58 cancelling queued work releases its UTF-8 and operation reservation", async () => {
  const { queue } = fixture();
  const cancel = new AbortController();
  const input = "x".repeat(inputQueueLimits.bytes);
  const first = observe(
    queue.send(input, "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
    }),
  );
  cancel.abort();
  expect(await first).toEqual(new Error("cancelled"));
  const replacement = observe(queue.send(input, "message"));
  queue.markReady();
  expect(await replacement).toBe("written");
  queue.close();
});

test.each([
  "resolve",
  "reject",
] as const)("C-API-58 active cancellation retains capacity until physical %s", async (outcome) => {
  const physical = Promise.withResolvers<void>();
  const submit = vi
    .fn()
    .mockImplementationOnce(() => physical.promise)
    .mockResolvedValue(undefined);
  const { queue } = fixture(submit);
  const cancel = new AbortController();
  const cancelled = new Error("cancelled");
  const first = observe(
    queue.send("x".repeat(inputQueueLimits.bytes), "prompt", undefined, {
      cancel: { signal: cancel.signal, error: () => cancelled },
    }),
  );
  cancel.abort();
  let overflowError: unknown;
  const overflow = queue.send("overflow", "prompt").catch((error: unknown) => {
    overflowError = error;
  });
  try {
    await Promise.resolve();
    expect(overflowError).toMatchObject({ code: "input_queue_full" });
  } finally {
    if (outcome === "resolve") physical.resolve();
    else physical.reject(new Error("write failed"));
    await overflow;
  }
  expect(await first).toBe(cancelled);
  await queue.send("replacement", "prompt");
  expect(submit.mock.calls.map((call) => call[0])).toEqual([
    "x".repeat(inputQueueLimits.bytes),
    "replacement",
  ]);
  queue.close();
});

test("C-API-58 success and synchronous failure release active capacity", async () => {
  const submit = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("write failed");
    })
    .mockResolvedValue(undefined);
  const { queue } = fixture(submit);
  const input = "x".repeat(inputQueueLimits.bytes);
  expect(await observe(queue.send(input, "prompt"))).toEqual(new Error("write failed"));
  await queue.send(input, "prompt");
  await queue.send(input, "prompt");
  expect(submit).toHaveBeenCalledTimes(3);
  queue.close();
});

test("C-API-58 full queue close preserves stopped precedence and rejects all waiting input", async () => {
  const { queue, stopped } = fixture();
  const waiting = Array.from({ length: inputQueueLimits.operations }, () =>
    observe(queue.send("", "message")),
  );
  queue.close();
  queue.close();
  expect((await Promise.all(waiting)).every((error) => error === stopped)).toBe(true);
  expect(await observe(queue.send("x".repeat(inputQueueLimits.bytes + 1), "prompt"))).toBe(stopped);
});

test("C-API-58 exclusive controls share count capacity and queued cancellation frees one slot", async () => {
  const { queue } = fixture();
  const cancel = new AbortController();
  const cancelled = observe(
    queue.send("", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
    }),
  );
  const pending = Array.from({ length: inputQueueLimits.operations - 1 }, () =>
    observe(queue.send("", "message")),
  );
  const run = vi.fn(() => Promise.resolve());
  let failure: unknown;
  const overflow = queue.runExclusive("list_models", run).catch((error: unknown) => {
    failure = error;
  });
  try {
    await Promise.resolve();
    expect(failure).toMatchObject({ code: "input_queue_full" });
    expect(run).not.toHaveBeenCalled();
    cancel.abort();
    await cancelled;
    await queue.runExclusive("list_models", run);
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    queue.close();
    await Promise.all([...pending, cancelled, overflow]);
  }
});
