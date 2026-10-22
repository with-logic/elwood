/** Public question agents remain correlated through request, event and activity (C-QUESTION-01). */
import { expect, test } from "vitest";
import type { ElwoodActivityEvent, ElwoodQuestionEvent } from "../../../src/index.ts";

test("C-QUESTION-01 question envelopes reject mismatched agents", () => {
  const request = { id: "r", agent: "claude", delivery: "blocking", questions: [] } as const;
  const question = { elwoodSessionId: "s", agent: "claude", request, phase: "raised" } as const;
  // @ts-expect-error Native request and event agents must match.
  const wrongEvent: ElwoodQuestionEvent = { ...question, agent: "codex" };
  const wrongActivity: ElwoodActivityEvent = {
    kind: "question",
    source: "terminal",
    label: "raised",
    elwoodSessionId: "s",
    agent: "codex",
    // @ts-expect-error Normalized activity and nested question agents must match.
    question,
  };
  void [wrongEvent, wrongActivity];
  expect(question.request.agent).toBe(question.agent);
});

test("C-QUESTION-01 question activity labels reject mismatched lifecycle phases", () => {
  const request = {
    id: "r",
    agent: "claude",
    delivery: "blocking",
    questions: [],
  } satisfies ElwoodQuestionEvent<"claude">["request"];
  const raised = {
    elwoodSessionId: "s",
    agent: "claude",
    request,
    phase: "raised",
  } satisfies ElwoodQuestionEvent<"claude">;
  const closed = {
    ...raised,
    phase: "closed",
    reason: "answered",
  } satisfies ElwoodQuestionEvent<"claude">;
  const raisedActivity = {
    ...raised,
    kind: "question",
    source: "terminal",
    label: "raised",
    question: raised,
  } satisfies ElwoodActivityEvent;
  const closedActivity = {
    ...raisedActivity,
    label: "closed",
    question: closed,
  } satisfies ElwoodActivityEvent;
  // @ts-expect-error A raised label cannot carry a closed lifecycle event.
  const wrongRaised: ElwoodActivityEvent = { ...raisedActivity, question: closed };
  // @ts-expect-error A closed label cannot carry a raised lifecycle event.
  const wrongClosed: ElwoodActivityEvent = { ...closedActivity, question: raised };
  // @ts-expect-error Closed question activity must retain its nested agent as well as phase.
  const wrongAgent: ElwoodActivityEvent = { ...closedActivity, agent: "codex" };
  void [wrongRaised, wrongClosed, wrongAgent];
  expect([raisedActivity.question.phase, closedActivity.question.phase]).toEqual([
    "raised",
    "closed",
  ]);
});
