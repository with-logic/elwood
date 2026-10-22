/** Uncertain native answers retain the shared input reservation (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const answersFor = (request: ElwoodQuestionRequest) => [
  { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
];

test.each([
  ["timeout", "native first"],
  ["timeout", "write first"],
  ["cancel", "native first"],
  ["cancel", "write first"],
] as const)("%s retains the lane until both conditions settle (%s)", async (reason, order) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const h = setup((io) => io.write("old", () => true));
  const send = h.input.automated.sendInput.bind(h.input.automated);
  const dispatch = vi
    .spyOn(h.input.automated, "sendInput")
    .mockImplementationOnce(async (input) => {
      entered.resolve();
      await release.promise;
      await send(input);
      completed.resolve();
    });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const cancellation = new AbortController();
  const run = h.transaction.run(h.adapter, h.request.id, h.answers, {
    timeoutMs: 50,
    signal: cancellation.signal,
  });
  const failure = expect(run).rejects.toMatchObject({ code: "question_answer_failed" });
  try {
    await entered.promise;
    const next = h.requests.publish("other", "blocking", [definitions[0]!])!;
    const successor: typeof h.adapter = {
      ...h.adapter,
      answer: async (_request, _answers, io) => {
        await io.write("next", () => true);
        h.requests.close(next.id, "answered");
      },
    };
    const blocked = async () => {
      await expect(h.transaction.run(successor, next.id, answersFor(next))).rejects.toMatchObject({
        code: "question_answer_failed",
      });
      expect(h.transaction.busy()).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    };
    if (reason === "cancel") cancellation.abort();
    await vi.advanceTimersByTimeAsync(50);
    await failure;
    await blocked();
    expect(h.writes).toEqual([]);
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    if (order === "native first") h.requests.close(h.request.id, "answered");
    else {
      release.resolve();
      await completed.promise;
      await vi.advanceTimersByTimeAsync(0);
    }
    await blocked();
    if (order === "native first") {
      release.resolve();
      await completed.promise;
      await vi.advanceTimersByTimeAsync(0);
    } else h.requests.close(h.request.id, "answered");
    expect(h.transaction.busy()).toBe(false);
    await h.transaction.run(successor, next.id, answersFor(next));
    expect(h.writes).toEqual(["old", "next"]);
  } finally {
    release.resolve();
  }
});

test.each([
  "answered",
  "timeout",
] as const)("a delivered answer holds the lane through native acknowledgement (%s)", async (outcome) => {
  const returned = Promise.withResolvers<void>();
  const h = setup(async (io) => {
    await io.write("answer", () => true);
    returned.resolve();
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const run = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
  const result = run.then(
    () => "accepted",
    () => "failed",
  );
  await returned.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.transaction.busy()).toBe(true);
  await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.writes).toEqual(["answer"]);
  if (outcome === "answered") {
    h.requests.close(h.request.id, "answered");
    expect(await result).toBe("accepted");
    expect(h.transaction.busy()).toBe(false);
  } else {
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe("failed");
    expect(h.transaction.busy()).toBe(true);
    expect(h.requests.get(h.request.id)).toBeUndefined();
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(h.writes).toEqual(["answer"]);
    h.requests.close(h.request.id, "answered");
    expect(h.transaction.busy()).toBe(false);
  }
});
