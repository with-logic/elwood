/** Changed native state and bounded redraw work for private adapters (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import * as questionFrames from "../../../src/codex/questions/frame.ts";
import { questionDefinitionCountLimit } from "../../../src/codex/questions/limits.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame } from "./helpers.ts";

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
test("count mismatch stops unique-content lookup at the second matching candidate", () => {
  const h = harness();
  h.observe(native(256));
  const matches = vi.spyOn(questionFrames, "matchesQuestion");
  h.adapter.render(editor(2));
  expect(matches).toHaveBeenCalledTimes(2);
  expect(h.registry.list()).toEqual([]);
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
