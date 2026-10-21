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
