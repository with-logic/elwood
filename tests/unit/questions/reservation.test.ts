/** Unpublished native question candidates reserve ordinary input (PRD §4). */
import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

test("pending metadata holds partial native UI and cannot be released by the old composer", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(frame("unrecognized repaint"));
  expect(adapter.blocksInput()).toBe(true);
  expect(requests.list()).toEqual([]);
  adapter.render(fixture("questions"));
  expect(requests.list()).toHaveLength(1);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});
test("hidden or misplaced composer cursors cannot clear a seen native question", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  for (const changed of [{ cursorVisible: false }, { cursorX: 0 }, { cursorRow: 0 }]) {
    adapter.render({ ...composer(), ...changed });
    expect(adapter.blocksInput()).toBe(true);
    expect(requests.list()).toHaveLength(1);
  }
});
test("equivalent hooks and unrelated completions do not request another parse", () => {
  const adapter = new ClaudeQuestionAdapter(registry());
  expect(adapter.observe(nativeHook())).toBe(true);
  expect(adapter.observe(nativeHook())).toBe(false);
  expect(adapter.observe(nativeHook("PermissionRequest", { tool_use_id: undefined }))).toBe(false);
  expect(adapter.observe(nativeHook("Notification"))).toBe(false);
  expect(adapter.observe(nativeHook("PostToolUse", { tool_use_id: "other" }))).toBe(false);
  expect(adapter.observe(nativeHook("PostToolUse"))).toBe(true);
  expect(adapter.observe(nativeHook("PostToolUse"))).toBe(false);
});
test("contradictory definitions sharing a native ID retire the old public identity", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const old = requests.list()[0]!;
  expect(
    adapter.observe(
      nativeHook("PreToolUse", {
        tool_input: {
          questions: nativeQuestions.map((q) => ({ ...q, question: `${q.question} Changed` })),
        },
      }),
    ),
  ).toBe(true);
  expect(requests.get(old.id)).toBeUndefined();
  adapter.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(true);
});

test("reordered ID-less metadata is an effective duplicate before publication", () => {
  const adapter = new ClaudeQuestionAdapter(registry());
  expect(adapter.observe(nativeHook("PreToolUse", { tool_use_id: undefined }))).toBe(true);
  expect(
    adapter.observe(
      nativeHook("PreToolUse", {
        tool_use_id: undefined,
        tool_input: {
          questions: nativeQuestions.map((q) => ({
            options: q.options,
            multiSelect: q.multiSelect,
            header: q.header,
            question: q.question,
          })),
        },
      }),
    ),
  ).toBe(false);
});
