/** Public question and progress discriminants require their payloads (PRD §5.4/§5.10). */
import { expect, expectTypeOf, test } from "vitest";
import type { CodexTranscriptSummary } from "../../../src/codex/transcript/types.ts";
import type { ElwoodActivityEvent, ElwoodQuestionEvent } from "../../../src/index.ts";

test("C-QUESTION-01 normalized questions require a structured lifecycle event", () => {
  expectTypeOf<
    Extract<ElwoodActivityEvent, { kind: "question" }>["question"]
  >().toEqualTypeOf<ElwoodQuestionEvent>();
  expectTypeOf<
    Extract<ElwoodActivityEvent, { kind: "question" }>["source"]
  >().toEqualTypeOf<"terminal">();
  expectTypeOf<Extract<ElwoodActivityEvent, { kind: "question" }>["label"]>().toEqualTypeOf<
    ElwoodQuestionEvent["phase"]
  >();
  expectTypeOf<Extract<ElwoodActivityEvent, { kind: "assistant_progress" }>>().toMatchObjectType<{
    readonly text: string;
  }>();
  expectTypeOf<Extract<CodexTranscriptSummary, { kind: "commentary" }>>().toMatchObjectType<{
    readonly text: string;
  }>();
});

test("question labels narrow their lifecycle payload without restricting optional activity fields", () => {
  type QuestionActivity = Extract<ElwoodActivityEvent, { kind: "question" }>;
  type RaisedEvent = Extract<ElwoodQuestionEvent, { phase: "raised" }>;
  type ClosedEvent = Extract<ElwoodQuestionEvent, { phase: "closed" }>;
  expectTypeOf<
    Extract<QuestionActivity, { label: "raised" }>["question"]
  >().toEqualTypeOf<RaisedEvent>();
  expectTypeOf<
    Extract<QuestionActivity, { label: "closed" }>["question"]
  >().toEqualTypeOf<ClosedEvent>();
  const request = { id: "request", agent: "codex", delivery: "queued", questions: [] } as const;
  const raised = { elwoodSessionId: "s", agent: "codex", request, phase: "raised" } as const;
  const closed = { ...raised, phase: "closed", reason: "answered" } as const;
  const base = {
    elwoodSessionId: "s",
    agent: "codex",
    source: "terminal",
    kind: "question",
  } as const;
  const raisedActivity: QuestionActivity = { ...base, label: "raised", question: raised };
  const closedActivity: QuestionActivity = { ...base, label: "closed", question: closed };
  // @ts-expect-error A raised activity cannot contain a closed lifecycle payload.
  const wrongRaised: QuestionActivity = { ...base, label: "raised", question: closed };
  // @ts-expect-error A closed activity cannot contain a raised lifecycle payload.
  const wrongClosed: QuestionActivity = { ...base, label: "closed", question: raised };
  // @ts-expect-error Question activities are sourced from the terminal.
  const wrongSource: QuestionActivity = { ...raisedActivity, source: "hook" };
  const optionalFields: QuestionActivity = { ...raisedActivity, text: "optional", raw: closed };
  void [wrongRaised, wrongClosed, wrongSource];
  expect(optionalFields.text).toBe("optional");
  expect(closedActivity.question.reason).toBe("answered");
});
