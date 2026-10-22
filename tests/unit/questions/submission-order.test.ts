/** Await correlated Claude completion despite an earlier composer redraw (PRD §4). */
import assert from "node:assert/strict";
import { afterEach, expect, test } from "vitest";
import { disposeTerminals } from "./controller-helpers.ts";
import { nativeHook } from "./lifecycle-helpers.ts";
import { type SubmissionScenario, submissionOrderDriver } from "./submission-order-driver.ts";
import { submissionOrderSnapshot } from "./submission-order-snapshot.ts";

afterEach(disposeTerminals);
async function submit(scenario: SubmissionScenario) {
  const caller = new AbortController();
  const driver = submissionOrderDriver(scenario);
  const { h, observed } = driver;
  try {
    await driver.start();
    const request = h.questions.list()[0];
    if (!request) throw new Error("Matching native questionnaire must publish a request");
    const answers = [
      { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[1]!.id] },
      {
        questionId: request.questions[1]!.id,
        optionIds: request.questions[1]!.options.map((option) => option.id),
      },
    ];
    const pending = h.questions
      .answer(request.id, answers, {
        timeoutMs: 3000,
        signal: caller.signal,
      })
      .then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    // Failure cases await the real answer operation; finalRender only synchronizes successful paints.
    const failureOutcome = scenario.failure ? await pending : undefined;
    if (!scenario.failure)
      await Promise.race([
        driver.finalRender,
        pending.then((outcome) => {
          if (outcome.kind === "failed") throw outcome.error;
          return driver.finalRender;
        }),
      ]);
    const requestsAtFinalRender = h.questions.list();
    if (scenario.abortAfterFinalRender) {
      caller.abort();
      await pending;
    }
    const stateAtFinalRender = scenario.failure
      ? undefined
      : submissionOrderSnapshot(h, request, observed);
    if (!scenario.failure && scenario.acknowledgementOrder === "composer-first")
      h.events.emit("activity", nativeHook("PostToolUse"));
    return {
      outcome: failureOutcome ?? (await pending),
      inputWriteCount: driver.inputWriteCount(),
      expectedInputWriteCount: driver.expectedInputWriteCount,
      renderFailures: driver.renderFailures,
      injectedRenderFailure: driver.injectedRenderFailure,
      observed,
      requestsAtFinalRender,
      request,
      stateAtFinalRender,
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
  assert.ok(result.stateAtFinalRender);
  expect(result.stateAtFinalRender).toEqual({
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
    result.stateAtFinalRender.closed,
  );
});

test.each([
  "first-render",
  "last-render",
] as const)("%s reaches the real answer operation through its rendered-write seam", async (failure) => {
  const result = await submit({ acknowledgementOrder: "composer-first", failure });
  expect(result.outcome).toMatchObject({
    kind: "failed",
    error: { code: "question_answer_failed", details: { category: "adapter" } },
  });
  expect(result.renderFailures).toHaveLength(1);
  expect(result.renderFailures[0]).toBe(result.injectedRenderFailure);
  expect(result.inputWriteCount).toBe(
    failure === "first-render" ? 1 : result.expectedInputWriteCount,
  );
});
test("an early input failure reaches the answer operation as terminal_write", async () => {
  const result = await submit({ acknowledgementOrder: "composer-first", failure: "input" });
  expect(result.outcome).toMatchObject({
    kind: "failed",
    error: { code: "question_answer_failed", details: { category: "terminal_write" } },
  });
  expect(result.inputWriteCount).toBe(1);
});
