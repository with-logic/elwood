/** Bound deferred-submission evidence to the current native work region (PRD §4). */
import { expect, test } from "vitest";
import {
  nativePendingPrompts,
  nativeQuestionFragment,
} from "../../../src/codex/questions/native-pending.ts";
import { frame } from "./helpers.ts";

test("a pending submission survives before the editor finishes painting", () => {
  const working = "• Working (3s • esc to interrupt)";
  const pending =
    "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ > Q";
  expect([...nativePendingPrompts(frame(`${working}\n${pending}`))]).toEqual(["Q"]);
  expect([...nativePendingPrompts(frame(`${pending}\n${working}`))]).toEqual([]);
});

test("unanchored pending rows cannot identify a current submission", () => {
  expect(
    nativePendingPrompts(frame("• Messages to be submitted after next tool call\n  ↳ > Q")),
  ).toEqual([]);
});

test("a blank row ends bounded quotation before a partially painted panel", () => {
  expect(
    nativeQuestionFragment(frame("• Explanation:\n  Quoted body\n\n  Question 1/2 (2 unanswered)")),
  ).toBe(true);
});
