/** First question failures survive bounded pending notification registrations (PRD §5.4). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { ElwoodWarningEvent } from "../../../src/core/types.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);

test.each([
  "distinct",
  "shared",
] as const)("the oldest rejected %s question observer reports the first failure beyond the pending cap", async (mode) => {
  const h = controllerHarness();
  const first = Promise.withResolvers<void>();
  const activity = Promise.withResolvers<void>();
  const pending = Array.from({ length: 1_024 }, () =>
    mode === "shared" ? first : Promise.withResolvers<void>(),
  );
  const warnings: ElwoodWarningEvent[] = [];
  const mirrors: ElwoodActivityEvent[] = [];
  h.events.on("question", () => first.promise);
  for (const result of pending) h.events.on("question", () => result.promise);
  h.events.on("activity", (event) => (event.kind === "question" ? activity.promise : undefined));
  h.events.on("warning", (warning) => warnings.push(warning));
  h.events.on("activity", (event) => {
    if (event.kind === "warning") mirrors.push(event);
  });
  try {
    const request = h.questions.registry.publish("native", "blocking", definitions)!;
    expect(warnings).toEqual([]);
    first.reject(new Error("PRIVATE_OBSERVER_FAILURE"));
    await setImmediate();
    expect(warnings).toMatchObject([
      { code: "question_observer_failed", phase: "question", agent: "claude" },
    ]);
    expect(mirrors).toMatchObject([
      { kind: "warning", label: "question_observer_failed", raw: warnings[0] },
    ]);
    expect(JSON.stringify([warnings, mirrors])).not.toContain("PRIVATE_OBSERVER_FAILURE");
    expect(h.questions.list()).toEqual([request]);
    expect(h.questions.blocksInput()).toBe(true);
    activity.reject(new Error("LATER_ACTIVITY_FAILURE"));
    await setImmediate();
    expect(warnings).toHaveLength(1);
    expect(mirrors).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ phase: "question" });
    h.questions.registry.retireUnconfirmed(request.id);
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.blocksInput()).toBe(true);
    expect(h.questions.registry.find("native")).toBe(request);
    h.questions.registry.close(request.id, "answered");
    expect(h.questions.blocksInput()).toBe(false);
    await setImmediate();
    expect(warnings).toHaveLength(1);
  } finally {
    first.resolve();
    activity.resolve();
    for (const result of pending) result.resolve();
    h.closing.abort();
    await setImmediate();
  }
});

test("an outer rejection boundary preserves the inner question failure phase", async () => {
  const h = controllerHarness();
  const outer: unknown[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  h.events.on("warning", (warning) => warnings.push(warning));
  h.events.on("question", () => Promise.reject(new Error("inner")));
  h.events.on("activity", (event) =>
    event.kind === "hook" ? Promise.reject(new Error("outer")) : undefined,
  );
  try {
    h.events.observeRejections(
      (error) => outer.push(error),
      () => {
        h.questions.registry.publish("native", "blocking", definitions);
        h.activity();
      },
    );
    await setImmediate();
    expect(outer).toEqual([expect.objectContaining({ message: "outer" })]);
    expect(warnings).toMatchObject([{ code: "question_observer_failed", phase: "question" }]);
  } finally {
    h.closing.abort();
    await setImmediate();
  }
});
