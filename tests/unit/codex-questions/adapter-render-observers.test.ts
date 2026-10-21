/** Adapter render batches publish every native unit before surfacing observer failures (PRD §4). */
import { expect, test, vi } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import { QuestionObserverFailure } from "../../../src/core/questions/notification-errors.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, records } from "./helpers.ts";

test.each([
  "registry observer",
  "emitter boundary",
] as const)("render publishes both native requests and mirrors through the %s", (boundary) => {
  const h = harness();
  const mirrors: QuestionActivityEvent[] = [];
  h.emitter.on("activity", (edge) => {
    if (edge.kind === "question") mirrors.push(edge);
  });
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  const original = new Error("first raised observer failed");
  let raised = 0;
  const failFirst = (edge: ElwoodQuestionEvent) => {
    if (edge.phase === "raised" && raised++ === 0) throw original;
  };
  if (boundary === "registry observer") {
    h.registry.onEvent(failFirst);
    let failure: unknown;
    try {
      h.adapter.render(captured("async-badge.txt"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(QuestionObserverFailure);
    if (!(failure instanceof QuestionObserverFailure))
      throw new Error("Missing batched observer failure");
    expect(failure.originalError).toBe(original);
  } else {
    h.emitter.on("question", failFirst);
    const report = vi.fn();
    expect(() =>
      h.emitter.observeErrors(report, () => h.adapter.render(captured("async-badge.txt"))),
    ).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(original);
  }
  expect(raised).toBe(2);
  const requests = h.registry.list();
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => h.registry.keyFor(request.id))).toEqual([
    queuedKey("call_c54736dbd68049d192ab5f52ad2532f0", 0),
    queuedKey("call_c54736dbd68049d192ab5f52ad2532f0", 1),
  ]);
  expect(requests.map((request) => request.questions[0]?.prompt)).toEqual([
    "ELWOOD_ASYNC_COLOR: Which color?",
    "ELWOOD_ASYNC_NOTE: What note?",
  ]);
  expect(h.events).toEqual(
    requests.map((request) => ({
      elwoodSessionId: "test",
      agent: "codex",
      phase: "raised",
      request,
    })),
  );
  expect(mirrors).toEqual(
    h.events.map((question) => ({
      elwoodSessionId: "test",
      agent: "codex",
      source: "terminal",
      kind: "question",
      label: "raised",
      question,
    })),
  );
  for (const [index, mirror] of mirrors.entries()) {
    expect(mirror.question).toBe(h.events[index]);
    expect(mirror.question.request).toBe(requests[index]);
  }
});
