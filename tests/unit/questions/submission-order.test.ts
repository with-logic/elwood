/** Await correlated Claude completion despite an earlier composer redraw (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import {
  disposeTerminals,
  paintQuestionFrame,
  controllerHarness as setup,
} from "./controller-helpers.ts";
import { fixture, frame } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

afterEach(disposeTerminals);
async function submit(scenario: {
  readonly acknowledgementOrder: "composer-first" | "hook-first";
  readonly abortAfterFinalRender?: true;
  readonly failure?: "input" | "first-render" | "last-render";
}) {
  const caller = new AbortController();
  const observed: ElwoodQuestionEvent[] = [];
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const successors = [
    fixture("color-blue-highlight"),
    fixture("features-initial"),
    logging,
    metrics,
    fixture("features-both"),
    other,
    fixture("features-submit-highlight"),
    fixture("review"),
    composer(),
  ];
  let inputWriteCount = 0;
  const finalRender = Promise.withResolvers<void>();
  const h = setup({ onInput });
  function onInput(): void {
    if (scenario.failure === "input") throw new Error("Synthetic terminal input failure");
    const next = successors[inputWriteCount++];
    if (!next) throw new Error("Unexpected extra answer write");
    const isFinalInput = inputWriteCount === successors.length;
    if (isFinalInput && scenario.acknowledgementOrder === "hook-first")
      h.events.emit("activity", nativeHook("PostToolUse"));
    const rejectRender =
      scenario.failure === "first-render" || (isFinalInput && scenario.failure === "last-render");
    const rendered = rejectRender
      ? Promise.reject(new Error("Synthetic native render rejection"))
      : render(next);
    void rendered.then(() => {
      if (isFinalInput) finalRender.resolve();
    }, finalRender.reject);
  }
  function render(current: QuestionFrame) {
    return paintQuestionFrame(h.terminal, current);
  }
  h.events.on("question", (event) => observed.push(event));
  h.questions.configure((requests) => new ClaudeQuestionAdapter(requests));
  try {
    h.events.emit("activity", nativeHook());
    await render(fixture("questions"));
    const request = h.questions.list()[0]!;
    const answers = [
      { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[1]!.id] },
      {
        questionId: request.questions[1]!.id,
        optionIds: request.questions[1]!.options.map((option) => option.id),
      },
    ];
    const pending = h.questions
      .answer(request.id, answers, { timeoutMs: 3000, signal: caller.signal })
      .then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    await Promise.race([
      finalRender.promise,
      pending.then((outcome) => {
        if (outcome.kind === "failed") throw outcome.error;
        return finalRender.promise;
      }),
    ]);
    const requestsAtFinalRender = h.questions.list();
    if (scenario.abortAfterFinalRender) {
      caller.abort();
      await pending;
    }
    const stateBeforeAcknowledgement = {
      answerable: h.questions.registry.get(request.id),
      requests: h.questions.list(),
      nativeReservation: h.questions.registry.find("native"),
      pending: h.questions.registry.hasPending(),
      blocksInput: h.questions.blocksInput(),
      closed: observed.filter((event) => event.phase === "closed"),
    };
    if (scenario.acknowledgementOrder === "composer-first")
      h.events.emit("activity", nativeHook("PostToolUse"));
    return {
      outcome: await pending,
      inputWriteCount,
      expectedInputWriteCount: successors.length,
      observed,
      requestsAtFinalRender,
      request,
      stateBeforeAcknowledgement,
      nativeReservationAfterAcknowledgement: h.questions.registry.find("native"),
      holdsInputAfterAcknowledgement: h.questions.blocksInput(),
    };
  } finally {
    h.closing.abort();
  }
}

test.each([
  "composer-first",
  "hook-first",
] as const)("%s preserves successful native acceptance", async (acknowledgementOrder) => {
  const result = await submit({ acknowledgementOrder });
  expect(result.inputWriteCount).toBe(result.expectedInputWriteCount);
  expect(result.outcome).toEqual({ kind: "resolved" });
  expect(result.observed.filter((event) => event.phase === "closed")).toEqual([
    expect.objectContaining({ phase: "closed", reason: "answered", request: result.request }),
  ]);
  if (acknowledgementOrder === "composer-first")
    expect(result.requestsAtFinalRender).toEqual([result.request]);
});

test("abort after final Enter retires API authority until the later native answer", async () => {
  const result = await submit({
    acknowledgementOrder: "composer-first",
    abortAfterFinalRender: true,
  });
  expect(result.outcome).toMatchObject({
    kind: "failed",
    error: { code: "question_answer_failed" },
  });
  expect(result.inputWriteCount).toBe(result.expectedInputWriteCount);
  expect(result.requestsAtFinalRender).toEqual([result.request]);
  expect(result.stateBeforeAcknowledgement).toEqual({
    answerable: undefined,
    requests: [],
    nativeReservation: result.request,
    pending: true,
    blocksInput: true,
    closed: [expect.objectContaining({ reason: "unavailable", request: result.request })],
  });
  expect(result.nativeReservationAfterAcknowledgement).toBeUndefined();
  expect(result.holdsInputAfterAcknowledgement).toBe(false);
  expect(result.observed.filter((event) => event.phase === "closed")).toEqual(
    result.stateBeforeAcknowledgement.closed,
  );
});

test.each([
  "first-render",
  "last-render",
] as const)("%s propagates the original rendering failure", async (failure) => {
  await expect(submit({ acknowledgementOrder: "composer-first", failure })).rejects.toThrow(
    "Synthetic native render rejection",
  );
});
test("an early answer failure rejects without waiting for the final rendering", async () => {
  await expect(
    submit({ acknowledgementOrder: "composer-first", failure: "input" }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
});
