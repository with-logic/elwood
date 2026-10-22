/** Content-free question observer diagnostics through real emitters (PRD §5.4, §5.10). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { ElwoodWarningEvent } from "../../../src/core/types.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);
const privateContent = "PRIVATE_OBSERVER_PROMPT_ANSWER";

test.each([
  ["question", "throw", "claude"],
  ["question", "reject", "claude"],
  ["activity", "throw", "claude"],
  ["activity", "reject", "claude"],
  ["question", "reject", "codex"],
] as const)("diagnoses %s %s once while preserving ownership and fan-out", async (phase, mode, agent) => {
  const h = controllerHarness({ agent });
  const answer = vi.fn(async () => {});
  h.questions.configure(() => ({ ...h.adapter, answer }));
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const order: string[] = [];
  const unrelated: ElwoodActivityEvent = {
    elwoodSessionId: "s",
    agent,
    source: "lifecycle",
    kind: "warning",
    label: "version_unparseable",
  };
  h.events.on("warning", (event) => {
    warnings.push(event);
    order.push("warning");
  });
  const fail = () => {
    if (mode === "reject") return Promise.reject(new Error(privateContent));
    throw new Error(privateContent);
  };
  if (phase === "question") h.events.on("question", fail);
  else h.events.on("activity", (event) => (event.kind === "question" ? fail() : undefined));
  h.events.on("question", (event) => order.push(`question:${event.phase}`));
  h.events.on("activity", (event) => {
    activities.push(event);
    if (event.kind === "question") order.push(`activity:${event.question.phase}`);
  });
  h.events.on("question", () => ({ answers: [privateContent] }));
  try {
    h.events.emit("activity", unrelated);
    expect(h.adapter.observe).toHaveBeenCalledWith(unrelated);
    const request = h.questions.registry.publish("native", "blocking", [
      { ...definitions[0]!, prompt: privateContent },
    ])!;
    expect(h.questions.list()).toEqual([request]);
    expect(h.questions.blocksInput()).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    await setImmediate();
    expect(order).toEqual(["question:raised", "activity:raised", "warning"]);
    expect(warnings).toEqual([
      {
        elwoodSessionId: "s",
        agent,
        source: "lifecycle",
        code: "question_observer_failed",
        severity: "warning",
        phase,
        message: "A question notification failed; native question ownership was preserved.",
        raw: `question_observer_failed phase=${phase}`,
      },
    ]);
    const warningActivity = activities.filter(
      (event) => event.kind === "warning" && event.label === "question_observer_failed",
    );
    expect(warningActivity).toEqual([
      {
        elwoodSessionId: "s",
        agent,
        source: "lifecycle",
        kind: "warning",
        label: "question_observer_failed",
        text: warnings[0]!.message,
        raw: warnings[0],
      },
    ]);
    expect(JSON.stringify([warnings, warningActivity])).not.toContain(privateContent);
    h.questions.registry.retireUnconfirmed(request.id);
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.blocksInput()).toBe(true);
    h.questions.registry.close(request.id, "answered");
    expect(h.questions.blocksInput()).toBe(false);
    h.questions.registry.publish("next", "blocking", definitions);
    h.closing.abort();
    await setImmediate();
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.blocksInput()).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(order.filter((value) => value !== "warning")).toEqual([
      "question:raised",
      "activity:raised",
      "question:closed",
      "activity:closed",
      "question:raised",
      "activity:raised",
      "question:closed",
      "activity:closed",
    ]);
  } finally {
    h.closing.abort();
  }
});

test.each([
  "throw",
  "reject",
] as const)("diagnostic %s failures cannot recursively warn", async (mode) => {
  const h = controllerHarness();
  let warnings = 0;
  let mirrors = 0;
  const fail = () => {
    if (mode === "reject") return Promise.reject(new Error(privateContent));
    throw new Error(privateContent);
  };
  h.events.on("question", fail);
  h.events.on("warning", fail);
  h.events.on("warning", () => warnings++);
  h.events.on("activity", (event) => (event.kind === "warning" ? fail() : undefined));
  h.events.on("activity", (event) => {
    if (event.kind === "warning") mirrors++;
  });
  try {
    h.questions.registry.publish("native", "blocking", definitions);
    await setImmediate();
    h.closing.abort();
    await setImmediate();
    expect(warnings).toBe(1);
    expect(mirrors).toBe(1);
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.blocksInput()).toBe(false);
  } finally {
    h.closing.abort();
  }
});

test("each live session owns its own first-failure diagnostic", () => {
  const sessions = [controllerHarness(), controllerHarness()];
  const warnings: ElwoodWarningEvent[] = [];
  try {
    for (const h of sessions) {
      h.events.on("warning", (warning) => warnings.push(warning));
      h.events.on("activity", (event) => {
        if (event.kind === "question") throw new Error(privateContent);
      });
      h.events.on("question", () => {
        throw new Error(privateContent);
      });
      h.questions.registry.publish("native", "blocking", definitions);
      h.closing.abort();
    }
    expect(warnings).toMatchObject([{ phase: "question" }, { phase: "question" }]);
  } finally {
    for (const h of sessions) h.closing.abort();
  }
});

test("the first observed failure wins over a later rejection from an earlier event", async () => {
  const h = controllerHarness();
  const warnings: ElwoodWarningEvent[] = [];
  const { promise: late, reject } = Promise.withResolvers<never>();
  h.events.on("question", () => late);
  h.events.on("activity", (event) => {
    if (event.kind === "question") throw new Error(privateContent);
  });
  h.events.on("warning", (warning) => warnings.push(warning));
  try {
    h.questions.registry.publish("native", "blocking", definitions);
    expect(warnings).toMatchObject([{ code: "question_observer_failed", phase: "activity" }]);
    reject(new Error(privateContent));
    await setImmediate();
    h.closing.abort();
    await setImmediate();
    expect(warnings).toHaveLength(1);
  } finally {
    h.closing.abort();
  }
});
