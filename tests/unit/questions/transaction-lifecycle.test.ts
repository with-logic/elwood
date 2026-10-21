/** Cancellation ordering and runtime options preserve native answer authority (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test("invalid runtime signals reject without wedging the next answer", async () => {
  const h = setup(async (io) => {
    await io.write("\r", () => true);
    h.requests.close(h.request.id, "answered");
  });
  await h.terminal.writeOutput("native question");
  const invalid = Reflect.apply(h.transaction.run, h.transaction, [
    h.adapter,
    h.request.id,
    h.answers,
    { signal: {} },
  ]);
  await expect(invalid).rejects.toMatchObject({ code: "invalid_question_answer" });
  expect(h.writes).toEqual([]);
  expect(h.transaction.busy()).toBe(false);
  await h.transaction.run(h.adapter, h.request.id, h.answers);
  expect(h.writes).toEqual(["\r"]);
  expect(h.transaction.busy()).toBe(false);
  expect(h.requests.list()).toEqual([]);
});

test("cancellation after adapter settlement cannot strand the native acceptance wait", async () => {
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  const h = setup(() => {
    entered.resolve();
    return answer.promise;
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  let outcome = "pending";
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers);
  const result = pending.catch((error: unknown) => {
    outcome = "failed";
    return error;
  });
  try {
    await entered.promise;
    // The race observer resolves first; this listener aborts before its await continuation.
    const abort = answer.promise.then(() => h.closing.abort());
    answer.resolve();
    await abort;
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("failed");
    expect(await result).toMatchObject({ code: "question_answer_failed" });
    expect(h.transaction.busy()).toBe(false);
    expect(h.requests.get(h.request.id)).toBe(h.request);
  } finally {
    h.requests.close(h.request.id, "answered");
  }
});

test("native acceptance immediately before the deadline wakes the waiting answer", async () => {
  const h = setup(async () => {});
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
  const result = pending.then(
    () => "accepted",
    () => "failed",
  );
  await vi.advanceTimersByTimeAsync(0);
  setTimeout(() => h.requests.close(h.request.id, "answered"), 49);
  await vi.advanceTimersByTimeAsync(60);
  expect(await result).toBe("accepted");
});

test("native acknowledgement does not stop the deadline while the adapter remains pending", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = setup(async (io) => {
    await io.write("answer", () => true);
    entered.resolve();
    await release.promise;
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  let outcome = "pending";
  const run = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
  const result = run.then(
    () => {
      outcome = "accepted";
      return undefined;
    },
    (error: unknown) => {
      outcome = "failed";
      return error;
    },
  );
  try {
    await entered.promise;
    h.requests.close(h.request.id, "answered");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("pending");
    expect(h.transaction.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome).toBe("failed");
    expect(await result).toMatchObject({
      code: "question_answer_failed",
      details: { category: "aborted" },
    });
    expect(h.writes).toEqual(["answer"]);
    expect(h.transaction.busy()).toBe(false);
  } finally {
    release.resolve();
    await result;
  }
});
