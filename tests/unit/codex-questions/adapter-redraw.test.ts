/** Changed native state and bounded redraw work for private adapters (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import * as questionFrames from "../../../src/codex/questions/frame.ts";
import { questionDefinitionCountLimit } from "../../../src/codex/questions/limits.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, event, frame, records } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());
const native = (count: number) => ({
  payload: {
    type: "AgentMessage",
    id: "same",
    delivery: "async",
    questions: Array.from({ length: count }, () => ({ title: "Question" })),
  },
});
const editor = (count: number) =>
  frame(
    `• Queued follow-up inputs\n\n  1 of ${count}\n  Question\n\n  Type your answer\n\n  enter submit   ⌃] skip   ⇧→ main prompt   ⇧← next question`,
  );
test("unchanged redraws publish once despite throwing observers", () => {
  const h = harness();
  const observerFailure = new Error("private observer failure");
  const report = vi.fn();
  h.emitter.on("question", () => {
    throw observerFailure;
  });
  h.observe(native(256));
  const badge = frame(captured("async-badge.txt").text.replace("? 2 questions", "? 256 questions"));
  const publish = vi.spyOn(CodexQuestionCandidates.prototype, "publish");
  const registryPublish = vi.spyOn(h.registry, "publish");
  h.emitter.observeErrors(report, () => {
    for (let n = 0; n < 1000; n++) h.adapter.render(badge);
  });
  expect(report).toHaveBeenCalledTimes(256);
  expect(report).toHaveBeenCalledWith(observerFailure);
  expect(publish).toHaveBeenCalledTimes(256);
  expect(registryPublish).toHaveBeenCalledTimes(256);
  expect(h.registry.list()).toHaveLength(256);
  expect(h.events).toHaveLength(256);
  expect(h.events.every((edge) => edge.phase === "raised")).toBe(true);
});
test("equal native counts select the indexed candidate before any uniqueness scan", () => {
  const h = harness();
  h.observe(native(256));
  const matches = vi.spyOn(questionFrames, "matchesQuestion");
  h.adapter.render(editor(256));
  expect(matches).toHaveBeenCalledTimes(1);
  expect(h.registry.list()).toHaveLength(256);
});
test("count mismatch stops unique-content lookup at the second matching candidate", () => {
  const h = harness();
  h.observe(native(256));
  const matches = vi.spyOn(questionFrames, "matchesQuestion");
  h.adapter.render(editor(2));
  expect(matches).toHaveBeenCalledTimes(2);
  expect(h.registry.list()).toEqual([]);
});
test("duplicate and unrelated activity report no render-relevant change", () => {
  const h = harness();
  const call = records("async-records.json")[1];
  expect(h.observe(call)).toBe(true);
  expect(h.observe(call)).toBe(false);
  expect(h.observe({ payload: { type: "agent_message", message: "ordinary" } })).toBe(false);
  expect(h.adapter.observe({ ...event(call), kind: "other", source: "hook" })).toBe(false);
  expect(h.observe({ payload: { type: "turn_complete" } })).toBe(true);
  expect(h.observe({ payload: { type: "turn_complete" } })).toBe(false);
});

test("first-request overflow forwards one content-free automation diagnostic", () => {
  const disabled = vi.fn();
  const h = harness(disabled);
  expect(h.observe(native(257))).toBe(true);
  expect(disabled.mock.calls).toEqual([[]]);
  expect(h.adapter.blocksInput()).toBe(true);
  expect(h.events).toEqual([]);
  h.observe(native(1));
  expect(disabled).toHaveBeenCalledTimes(1);
});

test("unchanged working frames keep indexed native correlation bounded", () => {
  const h = harness();
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "many",
      delivery: "async",
      questions: Array.from({ length: questionDefinitionCountLimit }, () => ({
        title: "ELWOOD_ASYNC_COLOR: Which color?",
        options: ["Amber", "Blue"],
      })),
    },
  });
  const current = captured("async-editor-first.txt");
  const many = {
    ...current,
    text: current.text.replace("1 of 2", `1 of ${questionDefinitionCountLimit}`),
    lines: current.lines.map((line) =>
      line.replace("1 of 2", `1 of ${questionDefinitionCountLimit}`),
    ),
  };
  const matches = vi.spyOn(questionFrames, "matchesQuestion");
  try {
    h.adapter.render(many);
    h.adapter.render(many);
    expect(matches).toHaveBeenCalledTimes(2);
    expect(h.registry.list()).toHaveLength(questionDefinitionCountLimit);
  } finally {
    matches.mockRestore();
  }
});
