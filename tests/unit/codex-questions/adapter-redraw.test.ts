/** Changed native state and bounded redraw work for private adapters (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import * as questionFrames from "../../../src/codex/questions/frame.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame, records } from "./helpers.ts";

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
test("an equal-count index mismatch does not fall back to a different matching unit", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(frame(captured("async-editor-first.txt").text.replace("1 of 2", "2 of 2")));
  expect(h.registry.list()).toEqual([]);
});
