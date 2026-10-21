/** Physical write settlement is independent of transaction revocation (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("synchronous transport throws settle the reservation without retaining native error causes", async () => {
  const h = setup((io) => io.write("answer", () => true));
  await h.terminal.writeOutput("question");
  vi.spyOn(h.input.automated, "sendInput").mockImplementationOnce(() => {
    throw new Error("PRIVATE_NATIVE_ERROR");
  });
  await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
    code: "question_answer_failed",
    details: { category: "terminal_write" },
  });
  expect(h.transaction.busy()).toBe(true);
  expect(h.writes).toEqual([]);
  h.requests.close(h.request.id, "answered");
  expect(h.transaction.busy()).toBe(false);
});

test("native acceptance and adapter failure retain all pending physical writes", async () => {
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const completed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const h = setup(async (io) => {
    const writes = [io.write("first", () => true), io.write("last", () => true)];
    void Promise.allSettled(writes);
    entered.resolve();
    await fail.promise;
    throw new Error("PRIVATE_ADAPTER_ERROR");
  });
  const send = h.input.automated.sendInput.bind(h.input.automated);
  const hold = (index: 0 | 1) => async (input: Parameters<typeof send>[0]) => {
    await releases[index].promise;
    await send(input);
    completed[index].resolve();
  };
  vi.spyOn(h.input.automated, "sendInput")
    .mockImplementationOnce(hold(0))
    .mockImplementationOnce(hold(1));
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const run = h.transaction.run(h.adapter, h.request.id, h.answers);
  const rejected = expect(run).rejects.toMatchObject({
    code: "question_answer_failed",
    details: { category: "adapter" },
  });
  try {
    await entered.promise;
    h.requests.close(h.request.id, "answered");
    fail.resolve();
    await rejected;
    expect(h.requests.hasPending()).toBe(false);
    expect(h.transaction.busy()).toBe(true);
    releases[0].resolve();
    await completed[0].promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).toEqual(["first"]);
    expect(h.transaction.busy()).toBe(true);
    releases[1].resolve();
    await completed[1].promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).toEqual(["first", "last"]);
    expect(h.transaction.busy()).toBe(false);
  } finally {
    for (const release of releases) release.resolve();
    fail.resolve();
  }
});

test("a signal getter cannot reenter and overwrite an active transaction", async () => {
  const h = setup(async (io) => {
    await io.write("inner", () => true);
    h.requests.close(h.request.id, "answered");
  });
  await h.terminal.writeOutput("question");
  let inner: Promise<void> | undefined;
  const options = {
    get signal(): AbortSignal {
      inner ??= h.transaction.run(h.adapter, h.request.id, h.answers);
      return new AbortController().signal;
    },
  };
  await expect(
    h.transaction.run(h.adapter, h.request.id, h.answers, options),
  ).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  await inner;
  expect(h.writes).toEqual(["inner"]);
  expect(h.transaction.busy()).toBe(false);
});
