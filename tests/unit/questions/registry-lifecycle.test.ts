/** Lifecycle observers cannot reorder edges or reopen a shutdown registry (PRD §4). */
import { expect, test } from "vitest";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import { definitions } from "./helpers.ts";

test.each([
  "question",
  "activity",
  "internal",
])("reentrant %s closure preserves the raised and closed event pairs", (source) => {
  const edges: string[] = [];
  const reasons: string[] = [];
  const requests = new QuestionRegistry("claude", "session", {
    emit: (name, event) => {
      const phase = "phase" in event ? event.phase : event.question.phase;
      edges.push(`${name}:${phase}`);
      if (name === "question" && "reason" in event) reasons.push(event.reason);
      if (name === source && phase === "raised") requests.clear("cancelled");
    },
  });
  if (source === "internal") {
    requests.onEvent((event) => {
      if (event.phase === "raised") requests.clear("cancelled");
    });
  }
  requests.publish("native", "queued", definitions);
  expect(edges).toEqual([
    "question:raised",
    "activity:raised",
    "question:closed",
    "activity:closed",
  ]);
  expect(requests.list()).toEqual([]);
  expect(reasons).toEqual(["cancelled"]);
});

test("shutdown latches before observers run while clear remains reusable", () => {
  const requests = new QuestionRegistry("claude", "s", { emit: () => {} });
  const reasons: string[] = [];
  requests.onEvent((event) => {
    if (event.phase === "closed") reasons.push(event.reason);
  });
  requests.publish("first", "queued", definitions);
  requests.clear("answered");
  expect(requests.publish("second", "queued", definitions)).toBeDefined();
  requests.onEvent((event) => {
    if (event.phase === "closed") {
      expect(requests.publish("reentrant", "queued", definitions)).toBeUndefined();
    }
  });
  requests.shutdown();
  requests.shutdown();
  expect(requests.publish("late", "queued", definitions)).toBeUndefined();
  expect(reasons).toEqual(["answered", "unavailable"]);
  expect(requests.list()).toEqual([]);
});

test("shutdown during replacement closure prevents its replacement from being raised", () => {
  const events: string[] = [];
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      if (name === "question" && "phase" in event) {
        events.push(event.phase);
        if (event.phase === "closed") requests.shutdown();
      }
    },
  });
  requests.publish("native", "queued", definitions);
  expect(requests.publish("native", "queued", [definitions[0]!])).toBeUndefined();
  expect(events).toEqual(["raised", "closed"]);
  expect(requests.list()).toEqual([]);
});

test("internal and outward failures still deliver all queued companion events", () => {
  const events: string[] = [];
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      const phase = "phase" in event ? event.phase : event.question.phase;
      events.push(`${name}:${phase}`);
      if (name === "question") throw new Error("external observer");
    },
  });
  requests.onEvent((event) => {
    if (event.phase === "raised") {
      requests.clear("cancelled");
      throw new Error("internal observer");
    }
  });
  expect(() => requests.publish("native", "queued", definitions)).toThrow("internal observer");
  expect(events).toEqual([
    "question:raised",
    "activity:raised",
    "question:closed",
    "activity:closed",
  ]);
  expect(requests.hasPending()).toBe(false);
});

test("shutdown remains latched when replacement closure throws", () => {
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      if (name === "question" && "phase" in event && event.phase === "closed") {
        requests.shutdown();
        throw new Error("close observer");
      }
    },
  });
  requests.publish("native", "queued", definitions);
  expect(() => requests.publish("native", "queued", [definitions[0]!])).toThrow("close observer");
  expect(requests.hasPending()).toBe(false);
});

test("clear retires every entry and preserves the first observer failure", () => {
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      if (name === "question" && "phase" in event && event.phase === "closed") {
        throw new Error(event.request.delivery);
      }
    },
  });
  requests.publish("first", "blocking", definitions);
  requests.publish("second", "queued", definitions);
  expect(requests.hasPending()).toBe(true);
  expect(() => requests.clear("unavailable")).toThrow("blocking");
  expect(requests.hasPending()).toBe(false);
});
