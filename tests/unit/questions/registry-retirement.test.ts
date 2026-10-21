/** Unconfirmed API requests close once while native ownership remains reserved (PRD §4). */
import { expect, test } from "vitest";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

function setup() {
  const events: ElwoodQuestionEvent[] = [];
  const activities: QuestionActivityEvent[] = [];
  const requests = new QuestionRegistry("claude", "s", {
    emit: (name, event) => {
      if (name === "question" && "phase" in event) events.push(event);
      if (name === "activity" && "question" in event) activities.push(event);
    },
  });
  return { requests, events, activities };
}

test("retirement hides only answerable views and preserves immutable discovery order", () => {
  const { requests, events, activities } = setup();
  const first = requests.publish("first", "queued", definitions)!;
  const retired = requests.publish("retired", "blocking", definitions)!;
  const last = requests.publish("last", "queued", definitions)!;
  const before = requests.list();
  requests.retireUnconfirmed(retired.id);
  expect(requests.list()).toEqual([first, last]);
  expect(Object.isFrozen(requests.list())).toBe(true);
  expect(before).toEqual([first, retired, last]);
  expect(Object.isFrozen(before)).toBe(true);
  expect(Object.isFrozen(retired.questions[0]!.options[0])).toBe(true);
  expect(requests.get(first.id)).toBe(first);
  expect(requests.get(retired.id)).toBeUndefined();
  expect(requests.find("retired")).toBe(retired);
  expect(requests.keyFor(retired.id)).toBe("retired");
  expect(requests.hasPending()).toBe(true);
  const closed = events.at(-1)!;
  expect(closed).toEqual({
    elwoodSessionId: "s",
    agent: "claude",
    phase: "closed",
    request: retired,
    reason: "unavailable",
  });
  expect(Object.isFrozen(closed)).toBe(true);
  expect(activities.at(-1)).toMatchObject({
    kind: "question",
    source: "terminal",
    label: "closed",
    question: closed,
  });
  expect(activities.at(-1)!.question).toBe(closed);
  const next = requests.publish("next", "queued", definitions)!;
  expect(requests.list()).toEqual([first, last, next]);
});

test("duplicate and reentrant retirement cannot republish or serialize the reserved key", () => {
  const { requests, events, activities } = setup();
  const request = requests.publish("native", "queued", definitions)!;
  let serialized = 0;
  const changed = [
    {
      ...definitions[0]!,
      get prompt() {
        serialized++;
        return "Changed";
      },
    },
  ];
  requests.onEvent((event) => {
    if (event.phase !== "closed") return;
    expect(requests.get(request.id)).toBeUndefined();
    requests.retireUnconfirmed(request.id);
    expect(requests.publish("native", "blocking", changed)).toBeUndefined();
  });
  requests.retireUnconfirmed(request.id);
  requests.retireUnconfirmed(request.id);
  requests.retireUnconfirmed("unknown");
  expect(requests.publish("native", "queued", definitions)).toBeUndefined();
  expect(requests.publish("native", "blocking", changed)).toBeUndefined();
  expect(serialized).toBe(0);
  expect(requests.find("native")).toBe(request);
  expect(requests.list()).toEqual([]);
  expect(requests.hasPending()).toBe(true);
  expect(events.map(({ phase }) => phase)).toEqual(["raised", "closed"]);
  expect(activities.map(({ label }) => label)).toEqual(["raised", "closed"]);
});

test("throwing observers leave the request retired and its native reservation intact", () => {
  const { requests, events, activities } = setup();
  const request = requests.publish("native", "queued", definitions)!;
  requests.onEvent(() => {
    throw new Error("observer");
  });
  expect(() => requests.retireUnconfirmed(request.id)).toThrow("observer");
  expect(requests.get(request.id)).toBeUndefined();
  expect(requests.find("native")).toBe(request);
  expect(requests.list()).toEqual([]);
  expect(requests.hasPending()).toBe(true);
  expect(requests.publish("native", "queued", definitions)).toBeUndefined();
  expect(() => requests.retireUnconfirmed(request.id)).not.toThrow();
  expect(events).toHaveLength(2);
  expect(activities).toHaveLength(2);
});

test.each([
  "answered",
  "cancelled",
  "unavailable",
] as const)("native %s closure silently releases a retired reservation", (reason) => {
  const { requests, events, activities } = setup();
  const request = requests.publish("native", "queued", definitions)!;
  requests.retireUnconfirmed(request.id);
  requests.close(requests.find("native")!.id, reason);
  requests.retireUnconfirmed(request.id);
  expect(requests.hasPending()).toBe(false);
  expect(requests.find("native")).toBeUndefined();
  expect(requests.keyFor(request.id)).toBeUndefined();
  expect(events.map(({ phase }) => phase)).toEqual(["raised", "closed"]);
  expect(activities).toHaveLength(2);
  expect(requests.publish("native", "queued", definitions)!.id).not.toBe(request.id);
});

test.each([
  "clear",
  "shutdown",
] as const)("%s releases active and retired reservations without a second closure", (action) => {
  const { requests, events } = setup();
  const retired = requests.publish("retired", "queued", definitions)!;
  const active = requests.publish("active", "queued", definitions)!;
  requests.retireUnconfirmed(retired.id);
  switch (action) {
    case "clear":
      requests.clear("answered");
      break;
    case "shutdown":
      requests.shutdown();
      break;
    default:
      throw new Error(`Unhandled registry action: ${action satisfies never}`);
  }
  expect(requests.hasPending()).toBe(false);
  expect(requests.list()).toEqual([]);
  expect(requests.find("retired")).toBeUndefined();
  expect(requests.find("active")).toBeUndefined();
  expect(
    events.filter((event) => event.phase === "closed" && event.request === retired),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.phase === "closed" && event.request === active),
  ).toHaveLength(1);
  expect(requests.publish("retired", "queued", definitions) !== undefined).toBe(action === "clear");
});

test("retirement during definition serialization cannot be replaced by the outer publication", () => {
  const { requests, events } = setup();
  const request = requests.publish("native", "queued", definitions)!;
  const changed = [definitions[0]!];
  Object.defineProperty(changed, "toJSON", {
    value: () => {
      requests.retireUnconfirmed(request.id);
      return [definitions[1]!];
    },
  });
  expect(requests.publish("native", "blocking", changed)).toBeUndefined();
  expect(requests.find("native")).toBe(request);
  expect(requests.get(request.id)).toBeUndefined();
  expect(requests.hasPending()).toBe(true);
  expect(events.map(({ phase }) => phase)).toEqual(["raised", "closed"]);
});
