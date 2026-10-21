/** Complete-batch byte limits and cheap overlap rejection before caller work (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions, registry } from "./helpers.ts";
import { disposeTransactionHarnesses, transactionHarness } from "./transaction-helpers.ts";

afterEach(disposeTransactionHarnesses);
const limit = 8 * 1024 * 1024;

test("counts UTF-8 question IDs and selected option IDs at the exact batch boundary", () => {
  const request = registry().publish("native", "queued", [definitions[0]!])!;
  const optionId = `${"é".repeat((limit - 2) / 2)}x`;
  const question = {
    ...request.questions[0]!,
    id: "q",
    options: [{ id: optionId, label: "Choice" }],
  };
  const bounded = { ...request, questions: [question] };
  expect(Buffer.byteLength(question.id) + Buffer.byteLength(optionId)).toBe(limit);
  const answer = {
    questionId: "q",
    optionIds: [optionId],
    get ignored() {
      throw new Error("Unknown properties are outside the byte budget");
    },
  };
  expect(validateQuestionAnswers(bounded, [answer])).toEqual([{ optionIndexes: [0] }]);
  const overLimitId = `${optionId}x`;
  const overLimit = {
    ...bounded,
    questions: [{ ...question, options: [{ id: overLimitId, label: "Choice" }] }],
  };
  expect(() =>
    validateQuestionAnswers(overLimit, [{ questionId: "q", optionIds: [overLimitId] }]),
  ).toThrow(expect.objectContaining({ code: "invalid_question_answer" }));
});

test("rejects an overlap before reading caller answer or timeout getters", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = transactionHarness(async () => {
    entered.resolve();
    await release.promise;
  });
  await h.terminal.writeOutput("question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers);
  try {
    await entered.promise;
    let reads = 0;
    const answer = {
      get questionId() {
        reads++;
        return h.request.questions[0]!.id;
      },
      text: "answer",
    };
    const options = {
      get timeoutMs() {
        reads++;
        return 20_000;
      },
    };
    await expect(
      h.transaction.run(h.adapter, h.request.id, [answer], options),
    ).rejects.toMatchObject({
      code: "question_answer_failed",
    });
    expect(reads).toBe(0);
    expect(h.writes).toEqual([]);
    h.requests.close(h.request.id, "answered");
  } finally {
    release.resolve();
    h.transaction.revoke();
    await Promise.allSettled([pending]);
  }
});

test.each([
  "answer",
  "signal",
])("keeps the native lane owned when a caller %s getter starts another answer", async (field) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let adapterCalls = 0;
  const h = transactionHarness(async () => {
    adapterCalls++;
    entered.resolve();
    await release.promise;
  });
  await h.terminal.writeOutput("question");
  let inner: Promise<void> | undefined;
  let reads = 0;
  const startInner = () => {
    reads++;
    inner = h.transaction.run(h.adapter, h.request.id, h.answers);
  };
  const answer = {
    get questionId() {
      if (field === "answer") startInner();
      return h.request.questions[0]!.id;
    },
    text: "outer answer",
  };
  const options = {
    get signal() {
      if (field === "signal") startInner();
      return new AbortController().signal;
    },
  };
  const outer = h.transaction.run(h.adapter, h.request.id, [answer], options);
  const outcome = outer.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    expect(adapterCalls).toBe(1);
    expect(reads).toBe(1);
    expect(await outcome).toMatchObject({ code: "question_answer_failed" });
    expect(h.transaction.busy()).toBe(true);
    expect(h.writes).toEqual([]);
  } finally {
    h.closing.abort();
    release.resolve();
    await Promise.allSettled([outer, ...(inner ? [inner] : [])]);
  }
});
