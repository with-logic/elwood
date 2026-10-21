/** Immutable native question lifecycle, deduplication and replacement (C-QUESTION-01). */
import { describe, expect, test } from "vitest";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

describe("C-QUESTION-01 registry", () => {
  test("orders frozen requests, deduplicates native mirrors and replaces changed authority", () => {
    const events: ElwoodQuestionEvent[] = [];
    const activities: unknown[] = [];
    const registry = new QuestionRegistry("claude", "s", {
      emit: (name, event) => {
        if (name === "question") events.push(event as ElwoodQuestionEvent);
        else activities.push(event);
      },
    });
    const observed: string[] = [];
    const off = registry.onEvent((event) => observed.push(event.phase));
    const first = registry.publish("a", "blocking", definitions)!;
    expect(registry.publish("a", "blocking", definitions)).toBe(first);
    const second = registry.publish("b", "queued", definitions)!;
    expect(registry.list()).toEqual([first, second]);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(first.questions[0]!.options[0])).toBe(true);
    const changed = registry.publish("a", "blocking", [definitions[0]!])!;
    expect(changed.id).not.toBe(first.id);
    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.find("a")).toBe(changed);
    registry.close("missing", "answered");
    off();
    registry.clear("unavailable");
    expect(registry.list()).toEqual([]);
    expect(events.map((event) => event.phase)).toEqual([
      "raised",
      "raised",
      "closed",
      "raised",
      "closed",
      "closed",
    ]);
    expect(observed).toEqual(["raised", "raised", "closed", "raised"]);
    expect(activities).toHaveLength(6);
  });
  test("commits close and companion activity before surfacing an observer failure", () => {
    let fail = false;
    let activities = 0;
    const registry = new QuestionRegistry("claude", "s", {
      emit: (name) => {
        if (name === "question" && fail) throw new Error("observer");
        if (name === "activity") activities++;
      },
    });
    const request = registry.publish("a", "blocking", definitions)!;
    fail = true;
    expect(() => registry.close(request.id, "answered")).toThrow("observer");
    expect(registry.list()).toEqual([]);
    expect(activities).toBe(2);
  });
  test("freezes event wrappers before public observers can corrupt companion activity", () => {
    let activityPhase: unknown;
    const requests = new QuestionRegistry("claude", "s", {
      emit: (name, event) => {
        if (name === "question") Reflect.set(event, "phase", "closed");
        else if ("question" in event) activityPhase = event.question?.phase;
      },
    });
    requests.publish("native", "blocking", definitions);
    expect(activityPhase).toBe("raised");
    expect(requests.list()).toHaveLength(1);
  });
  test("semantic replacement survives a throwing close observer and delivers its new raised edge", () => {
    let phase = "";
    const requests = new QuestionRegistry("claude", "s", {
      emit: (name, event) => {
        if (name === "question" && "phase" in event) {
          phase = event.phase;
          if (event.phase === "closed") throw new Error("close observer");
        }
      },
    });
    const first = requests.publish("native", "blocking", definitions)!;
    expect(() => requests.publish("native", "blocking", [definitions[0]!])).toThrow(
      "close observer",
    );
    expect(requests.get(first.id)).toBeUndefined();
    expect(requests.list()).toHaveLength(1);
    expect(phase).toBe("raised");
  });
  test("replacement preserves its first observer error when closure and the new raised edge both throw", () => {
    let fail = false;
    let raised = 0;
    const requests = new QuestionRegistry("claude", "s", {
      emit: (name, event) => {
        if (name !== "question" || !("phase" in event)) return;
        if (event.phase === "raised") raised++;
        if (fail)
          throw new Error(
            event.phase === "closed" ? "first closure failure" : "later raised failure",
          );
      },
    });
    const first = requests.publish("native", "blocking", definitions)!;
    fail = true;
    expect(() => requests.publish("native", "blocking", [definitions[0]!])).toThrow(
      "first closure failure",
    );
    expect(raised).toBe(2);
    expect(requests.get(first.id)).toBeUndefined();
    expect(requests.list()).toHaveLength(1);
  });
});
