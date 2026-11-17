/** Claude's initial questionnaire paint precedes input readiness (PRD §5.10, C-QUESTION-03). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, singleQuestionToolInput } from "./lifecycle-helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";
import { submissionHarness } from "./submission-helpers.ts";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook("PreToolUse", { tool_input: singleQuestionToolInput }));
  const initial = fixture("freeform-questions");
  const scripted = scriptedQuestionIo(initial, []);
  return { requests, adapter, initial, ...scripted };
}

test("C-QUESTION-03 an immediate raised-event answer waits for input grace once across redraws", async () => {
  const h = setup();
  let pending: Promise<void> | undefined;
  h.requests.onEvent((event) => {
    if (event.phase === "raised")
      pending = h.adapter.answer(event.request, [{ optionIndexes: [0] }], h.io);
  });
  h.adapter.render(h.initial);
  expect(pending).toBeDefined();
  await vi.advanceTimersByTimeAsync(1_000);
  h.adapter.render(h.initial);
  await vi.advanceTimersByTimeAsync(499);
  expect(h.writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(h.writes).toEqual(["\r"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("C-QUESTION-03 an answer after the grace period needs no additional delay", async () => {
  const h = setup();
  h.adapter.render(h.initial);
  await vi.advanceTimersByTimeAsync(1_500);
  const request = h.requests.list()[0]!;
  await h.adapter.answer(request, [{ optionIndexes: [0] }], h.io);
  expect(h.writes).toEqual(["\r"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("C-QUESTION-03 cancellation during input grace prevents every answer key", async () => {
  const h = setup();
  h.adapter.render(h.initial);
  const abort = new AbortController();
  const pending = h.adapter.answer(h.requests.list()[0]!, [{ optionIndexes: [0] }], {
    ...h.io,
    signal: abort.signal,
  });
  const failed = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  await vi.advanceTimersByTimeAsync(1_000);
  abort.abort();
  await failed;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(h.writes).toEqual([]);
});

test.each([
  "replacement",
  "retired",
  "layout",
])("C-QUESTION-03 rechecks %s after input grace", async (change) => {
  const h = setup();
  h.adapter.render(h.initial);
  const request: ElwoodQuestionRequest = h.requests.list()[0]!;
  let current = h.initial;
  const pending = h.adapter.answer(request, [{ optionIndexes: [0] }], {
    ...h.io,
    frame: () => current,
  });
  const failed = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  await vi.advanceTimersByTimeAsync(1_000);
  if (change === "replacement")
    h.adapter.observe(nativeHook("PostToolUse", { tool_input: singleQuestionToolInput }));
  else if (change === "retired") h.requests.retireUnconfirmed(request.id);
  else current = frame("Unrecognized replacement dialog");
  await vi.advanceTimersByTimeAsync(500);
  await failed;
  expect(h.writes).toEqual([]);
});

test("C-QUESTION-03 an unpublished candidate has no input-readiness authority", async () => {
  const h = setup();
  const request = h.requests.publish("native", "blocking", [
    {
      prompt: "Which test note?",
      options: [],
      selection: "none",
      textMode: "alternative",
      supportsSecretInput: false,
    },
  ])!;
  await expect(h.adapter.answer(request, [{ optionIndexes: [] }], h.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.writes).toEqual([]);
});

test("C-QUESTION-03 the public answer deadline includes input grace without retiring an unwritten request", async () => {
  const h = submissionHarness(fixture("freeform-questions"), [composer()], singleQuestionToolInput);
  try {
    await h.start();
    const paintedAt = performance.now();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.advanceTimersByTime(paintedAt);
    const request = h.questions.list()[0]!;
    const pending = h.questions.answer(
      request.id,
      [{ questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] }],
      { timeoutMs: 1_000 },
    );
    const failed = expect(pending).rejects.toMatchObject({
      code: "question_answer_failed",
      details: { category: "aborted" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(h.writes).toEqual([]);
    expect(h.questions.list()).toEqual([request]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    h.dispose();
  }
});
