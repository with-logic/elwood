/** Native post-picker Claude composer clearance survives transcript carets (C-API-55). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";

const captured = readFileSync(
  new URL("../fixtures/claude-2.1.278/model-cancelled.txt", import.meta.url),
  "utf8",
);

test("C-API-55 Claude 2.1.278's final composer clears the picker despite /model history", () => {
  expect(claudeModelPicker.isClear(captured)).toBe(true);
});

test.each([
  "",
  "❯",
  "────────\n❯\n────────",
  "Select model\n❯ 1. Sonnet  Default",
  captured.replace("❯  ", "❯ 1. Yes"),
  `${captured}\nDo you want to run this?\n❯ 1. Yes\n  2. No`,
  captured.replace("0 tokens", "esc to interrupt"),
])("C-API-55 partial, dialog, and working frames cannot clear a model hold: %s", (frame) => {
  expect(claudeModelPicker.isClear(frame)).toBe(false);
});
