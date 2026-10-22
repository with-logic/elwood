/** Captured native layouts, cursor ownership, and draft safety (PRD §4). */
import { expect, test } from "vitest";
import { blockingQuestionVisible } from "../../../src/codex/questions/chrome.ts";
import { matchesQuestion, questionView, queuedBadge } from "../../../src/codex/questions/frame.ts";
import { codexScreenFactTable } from "../../../src/codex/screen-table.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { captured, frame } from "./helpers.ts";
import { snapshot } from "./snapshot-fixtures.ts";

test("recognizes modal input blocking independently of queued availability", () => {
  expect(blockingQuestionVisible(captured("blocking-modal-first.txt").text)).toBe(true);
  expect(blockingQuestionVisible(captured("blocking-modal-note.txt").text)).toBe(true);
  expect(blockingQuestionVisible("")).toBe(false);
  expect(blockingQuestionVisible("Question 1/2 (2 unanswered)\nOther footer")).toBe(false);
  expect(blockingQuestionVisible(captured("async-editor-first.txt").text)).toBe(true);
  expect(questionView(captured("blocking-modal-first.txt"))).toMatchObject({
    kind: "blocking",
    index: 0,
    count: 2,
    selected: 0,
    notes: false,
  });
  expect(questionView(captured("blocking-modal-note.txt"))).toMatchObject({
    kind: "blocking",
    index: 1,
    selected: 2,
    notes: true,
  });
  expect(queuedBadge(captured("async-badge.txt"))).toBe(2);
  const singular = snapshot("async-collapsed-after-escape.json");
  expect(queuedBadge({ ...singular, cursorRow: singular.cursorY })).toBe(1);
  expect(
    readScreenFacts(codexScreenFactTable, {
      text: captured("blocking-modal-first.txt").text,
      title: "",
    }).facts.blocking_prompt_visible,
  ).toBe(true);
});
test("rejects partial, unknown, quoted and stale cursor layouts", () => {
  const first = captured("async-editor-first.txt");
  for (const invalid of [
    frame(""),
    frame("enter submit   ⌃] skip   ⇧→ main prompt"),
    frame(
      "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    ),
    frame(first.text.replace("1 of 2", "0 of 2")),
    frame(first.text.replace("1 of 2", "3 of 2")),
    { ...first, cursorRow: -1 },
    { ...first, cursorRow: 100 },
    { ...first, cursorRow: 0 },
    frame(`${first.text.trimEnd()}\n› normal composer`),
  ])
    expect(questionView(invalid)).toBeUndefined();
  const badge = captured("async-badge.txt");
  for (const invalid of [
    frame(""),
    frame("• Queued follow-up inputs"),
    frame(badge.text.replace("⇧← to answer", "new binding")),
    frame(badge.text.replaceAll("› Ask Codex to do anything", "no composer")),
  ])
    expect(queuedBadge(invalid)).toBeUndefined();
});
test("validates full prompt and ordered option labels", () => {
  const view = questionView(captured("async-editor-first.txt"))!;
  const question: QuestionDefinition = {
    prompt: "ELWOOD_ASYNC_COLOR: Which color?",
    options: [{ label: "Amber" }, { label: "Blue" }],
    selection: "single",
    textMode: "alternative",
    secret: false,
  };
  expect(matchesQuestion(view, question)).toBe(true);
  expect(matchesQuestion(view, { ...question, prompt: "Other" })).toBe(false);
  expect(matchesQuestion(view, { ...question, options: [{ label: "Blue" }] })).toBe(false);
  expect(matchesQuestion(view, { ...question, options: [{ label: "Missing" }] })).toBe(false);
  expect(
    matchesQuestion(view, {
      ...question,
      options: [{ label: "Amber", description: "Warm" }, { label: "Blue" }],
    }),
  ).toBe(false);
  const described = {
    ...question,
    options: [{ label: "Amber", description: "Warm" }, { label: "Blue" }],
  };
  const withDescription = (description: string) => ({
    ...view,
    body: view.body.map((line) => line.replace("1. Amber", `1. Amber  ${description}`)),
  });
  expect(matchesQuestion(withDescription("Warm"), described)).toBe(true);
  expect(matchesQuestion(withDescription("Cold"), described)).toBe(false);
  const quoted = {
    ...view,
    body: view.body
      .map((line) => (line === question.prompt ? "Foreign heading" : line))
      .concat(question.prompt),
  };
  expect(matchesQuestion(quoted, question)).toBe(false);
  expect(
    matchesQuestion({ ...view, body: view.body.filter((line) => line !== "1 of 2") }, question),
  ).toBe(false);
});

test("later queued pages accept the previous-question footer", () => {
  const later = captured("async-editor-first.txt")
    .text.replace("1 of 2", "2 of 2")
    .replace("⇧→ main prompt", "⇧→ prev question");
  expect(questionView(frame(later))).toMatchObject({ kind: "queued", index: 1, count: 2 });
});
