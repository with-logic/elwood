/** Reentrant lifecycle delivery preserves native identity indexes and edge order (PRD §4). */
import { expect, test } from "vitest";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

test("same-key publication during replacement cannot leave an unindexed request", () => {
  let nested: ElwoodQuestionRequest | undefined;
  let replacing = false;
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      if (name === "question" && "phase" in event && event.phase === "closed" && replacing) {
        replacing = false;
        nested = requests.publish("native", "queued", definitions);
      }
    },
  });
  const first = requests.publish("native", "queued", definitions)!;
  replacing = true;
  const replacement = requests.publish("native", "queued", [definitions[0]!])!;
  expect(nested).toBeUndefined();
  expect(requests.get(first.id)).toBeUndefined();
  expect(requests.list()).toEqual([replacement]);
  expect(requests.find("native")).toBe(replacement);
  requests.close(first.id, "answered");
  expect(requests.find("native")).toBe(replacement);
  requests.close(replacement.id, "answered");
  expect(requests.find("native")).toBeUndefined();
  expect(requests.list()).toEqual([]);
});

test("every internal observer sees raised before a reentrant closed transition", () => {
  const edges: string[] = [];
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      const phase = "phase" in event ? event.phase : event.question.phase;
      edges.push(`${name}:${phase}`);
    },
  });
  requests.onEvent((event) => {
    edges.push(`first:${event.phase}`);
    if (event.phase === "raised") {
      requests.close(event.request.id, "answered");
      expect(requests.hasPending()).toBe(false);
    }
  });
  requests.onEvent((event) => edges.push(`second:${event.phase}`));
  requests.publish("native", "queued", definitions);
  expect(edges).toEqual([
    "first:raised",
    "second:raised",
    "question:raised",
    "activity:raised",
    "first:closed",
    "second:closed",
    "question:closed",
    "activity:closed",
  ]);
});

test("publication guard releases after an observer throws", () => {
  let fail = true;
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name) => {
      if (name === "question" && fail) throw new Error("observer");
    },
  });
  expect(() => requests.publish("native", "queued", definitions)).toThrow("observer");
  fail = false;
  const replacement = requests.publish("native", "queued", [definitions[0]!]);
  expect(replacement).toBeDefined();
  expect(requests.list()).toEqual([replacement]);
});
