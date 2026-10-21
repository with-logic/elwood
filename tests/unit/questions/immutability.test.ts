/** Frozen kernel payloads retain shared request identity across event surfaces (PRD §4). */
import { expect, test } from "vitest";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

test("deep freezes request snapshots and both lifecycle event wrappers", () => {
  const questions: ElwoodQuestionEvent[] = [];
  const activities: QuestionActivityEvent[] = [];
  const requests = new QuestionRegistry("codex", "session", {
    emit: (name, payload) => {
      if (name === "question") {
        expect("phase" in payload).toBe(true);
        if ("phase" in payload) questions.push(payload);
      } else {
        expect("question" in payload).toBe(true);
        if ("question" in payload) activities.push(payload);
      }
    },
  });
  const request = requests.publish("native", "queued", definitions)!;
  expect(request.questions).toEqual(
    definitions.map((question) => ({
      ...question,
      id: expect.any(String),
      options: question.options.map((option) => ({ ...option, id: expect.any(String) })),
    })),
  );
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.questions)).toBe(true);
  for (const question of request.questions) {
    expect(Object.isFrozen(question)).toBe(true);
    expect(Object.isFrozen(question.options)).toBe(true);
    for (const option of question.options) expect(Object.isFrozen(option)).toBe(true);
  }
  requests.close(request.id, "answered");
  expect(questions).toEqual([
    { elwoodSessionId: "session", agent: "codex", request, phase: "raised" },
    { elwoodSessionId: "session", agent: "codex", request, phase: "closed", reason: "answered" },
  ]);
  expect(activities).toEqual(
    questions.map((event) => ({
      elwoodSessionId: "session",
      agent: "codex",
      source: "terminal",
      kind: "question",
      label: event.phase,
      question: event,
    })),
  );
  for (const [index, event] of questions.entries()) {
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(activities[index])).toBe(true);
    expect(activities[index]!.question).toBe(event);
    expect(event.request).toBe(request);
  }
});
