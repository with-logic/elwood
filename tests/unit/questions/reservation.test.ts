/** Unpublished native question candidates reserve ordinary input (PRD §4). */

import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

test("C-QUESTION-03 pending metadata holds partial native UI and cannot be released by the old composer", () => {
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
test("C-QUESTION-03 equivalent hooks and unrelated completions do not request another parse", () => {
  const adapter = new ClaudeQuestionAdapter(registry());
  expect(adapter.observe(nativeHook())).toBe(true);
  expect(adapter.observe(nativeHook())).toBe(false);
  expect(adapter.observe(nativeHook("PermissionRequest", { tool_use_id: undefined }))).toBe(false);
  expect(adapter.observe(nativeHook("Notification"))).toBe(false);
  expect(adapter.observe(nativeHook("PostToolUse", { tool_use_id: "other" }))).toBe(false);
  expect(adapter.observe(nativeHook("PostToolUse"))).toBe(true);
  expect(adapter.observe(nativeHook("PostToolUse"))).toBe(false);
});
