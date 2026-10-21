/** Native blocking footer recognition is independent of the question parser (PRD §4). */
import { expect, test } from "vitest";
import { blockingQuestionVisible } from "../../../src/codex/questions/chrome.ts";
import { codexScreenFactTable } from "../../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { fixture } from "./helpers.ts";

test("C-ATTN-02 blocking chrome requires its native header and terminal footer", () => {
  const header = "Question 1/2 (2 unanswered)";
  expect(
    blockingQuestionVisible(
      `${header}\ntab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt`,
    ),
  ).toBe(true);
  expect(
    blockingQuestionVisible(`${header}\ntab or esc to clear notes | enter to submit all`),
  ).toBe(true);
  expect(blockingQuestionVisible(`${header}\nOther footer`)).toBe(false);
  expect(blockingQuestionVisible("tab or esc to clear notes | enter to submit answer")).toBe(false);
  expect(blockingQuestionVisible("")).toBe(false);
});

test.each([
  "async-editor-first.txt",
  "blocking-modal-first.txt",
])("C-ATTN-02 captured %s blocks through the production screen facts", (name) => {
  expect(
    readScreenFacts(codexScreenFactTable, { text: fixture(name), title: "" }).facts
      .blocking_prompt_visible,
  ).toBe(true);
});

test("C-ATTN-02 queued editors require their own header and footer", () => {
  const header = "• Queued follow-up inputs";
  const footer = "enter submit   ⌃] skip   ⇧→ main prompt   ⇧← next question";
  expect(blockingQuestionVisible(`${header}\n${footer}`)).toBe(true);
  expect(blockingQuestionVisible(`${header}\n? 1 question\n⇧← to answer\n› Ask Codex`)).toBe(false);
  expect(blockingQuestionVisible(`${header}\nOther footer`)).toBe(false);
  expect(blockingQuestionVisible(footer)).toBe(false);
  expect(blockingQuestionVisible(`Quoted ${header}\n${footer}`)).toBe(false);
  expect(blockingQuestionVisible(`Question 1/2 (2 unanswered)\n${footer}`)).toBe(false);
  expect(
    blockingQuestionVisible(`${header}\ntab or esc to clear notes | enter to submit all`),
  ).toBe(false);
});
