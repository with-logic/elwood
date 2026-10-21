/** Unconfirmed native writes cannot be replayed after timeout or intervention (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { definitions } from "./helpers.ts";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a timed-out real write lane may complete late but cannot duplicate bytes on retry", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const h = setup((io) => io.write("answer", () => true));
  const closed: string[] = [];
  h.requests.onEvent((event) => {
    if (event.phase === "closed" && event.request.id === h.request.id) closed.push(event.reason);
  });
  const send = h.input.automated.sendInput.bind(h.input.automated);
  vi.spyOn(h.input.automated, "sendInput").mockImplementationOnce(async (input) => {
    entered.resolve();
    await release.promise;
    await send(input);
    completed.resolve();
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  let outcome = "pending";
  const first = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
  void first.then(
    () => {
      outcome = "accepted";
    },
    () => {
      outcome = "failed";
    },
  );
  const failed = expect(first).rejects.toMatchObject({ code: "question_answer_failed" });
  try {
    await entered.promise;
    const other = h.requests.publish("other", "queued", [definitions[0]!])!;
    h.requests.close(other.id, "unavailable");
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome).toBe("failed");
    await failed;
    expect(h.transaction.busy()).toBe(true);
    const retryFailed = expect(
      h.transaction.run(h.adapter, h.request.id, h.answers),
    ).rejects.toMatchObject({
      code: "question_not_found",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).toEqual([]);
    await retryFailed;
    expect(h.requests.get(h.request.id)).toBeUndefined();
    expect(h.requests.list()).toEqual([]);
    expect(h.requests.hasPending()).toBe(true);
    expect(h.requests.find("native")).toBe(h.request);
    expect(closed).toEqual(["unavailable"]);
    expect(h.requests.publish("native", "blocking", [definitions[1]!])).toBeUndefined();
    release.resolve();
    await completed.promise;
    expect(h.writes).toEqual(["answer"]);
    vi.useRealTimers();
    await h.terminal.writeOutput(" cosmetic redraw");
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(h.writes).toEqual(["answer"]);
    h.requests.close(h.request.id, "answered");
    expect(h.requests.hasPending()).toBe(false);
    expect(closed).toEqual(["unavailable"]);
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    const next = h.requests.publish("native", "blocking", [definitions[0]!])!;
    const retry = {
      ...h.adapter,
      answer: async (
        _request: unknown,
        _answers: unknown,
        io: Parameters<typeof h.adapter.answer>[2],
      ) => {
        await io.write("next", () => true);
        h.requests.close(next.id, "answered");
      },
    };
    await h.transaction.run(retry, next.id, [
      { questionId: next.questions[0]!.id, optionIds: [next.questions[0]!.options[0]!.id] },
    ]);
    expect(h.writes).toEqual(["answer", "next"]);
    expect(closed).toEqual(["unavailable"]);
  } finally {
    release.resolve();
  }
});

test("an unwritten timed-out attempt remains retryable", async () => {
  const entered = Promise.withResolvers<void>();
  const h = setup(async (io) => {
    entered.resolve();
    await io.wait(() => false);
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
  const failed = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  expect(h.writes).toEqual([]);
  expect(h.requests.get(h.request.id)).toBe(h.request);
  const retry = {
    ...h.adapter,
    answer: async (
      _request: unknown,
      _answers: unknown,
      io: Parameters<typeof h.adapter.answer>[2],
    ) => {
      await io.write("retry", () => true);
      h.requests.close(h.request.id, "answered");
    },
  };
  await h.transaction.run(retry, h.request.id, h.answers);
  expect(h.writes).toEqual(["retry"]);
});

test.each([
  "terminal",
  "observer",
  "accepted",
] as const)("terminal and post-acceptance adapter failures retain safe, content-free classification (%s)", async (kind) => {
  const secret = "PRIVATE_ANSWER_IN_NATIVE_ERROR";
  const h = setup(async (io) => {
    await io.write("answer", () => true);
    h.requests.close(h.request.id, "answered");
    throw new Error(secret);
  });
  await h.terminal.writeOutput("question");
  const retire = vi.spyOn(h.requests, "retireUnconfirmed");
  if (kind !== "accepted")
    vi.spyOn(h.input.automated, "sendInput").mockRejectedValueOnce(new Error(secret));
  if (kind === "observer")
    h.requests.onEvent(() => {
      throw new Error(`${secret}_OBSERVER`);
    });
  const failure: unknown = await h.transaction
    .run(h.adapter, h.request.id, h.answers)
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "question_answer_failed",
    details: { phase: kind === "accepted" ? "adapter" : "terminal_write" },
  });
  expect(String(failure)).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error) {
    expect(failure.stack).not.toContain(secret);
    expect(failure.cause).toBeUndefined();
  }
  expect(h.transaction.busy()).toBe(kind !== "accepted");
  expect(h.requests.get(h.request.id)).toBeUndefined();
  expect(h.requests.list()).toEqual([]);
  if (kind === "accepted") {
    expect(retire).not.toHaveBeenCalled();
    expect(h.requests.hasPending()).toBe(false);
  } else {
    expect(retire).toHaveBeenCalledExactlyOnceWith(h.request.id);
    expect(h.requests.find("native")).toBe(h.request);
    expect(h.requests.hasPending()).toBe(true);
    h.requests.close(h.request.id, "answered");
    expect(h.transaction.busy()).toBe(false);
  }
});
