/** Captured native layouts, cursor ownership, and draft safety (PRD §7A.5). */
import { expect, test } from "vitest";
import { draftMatches } from "../../../src/codex/questions/draft.ts";
import {
  blockingQuestionVisible,
  matchesQuestion,
  questionView,
  queuedBadge,
} from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured, frame } from "./helpers.ts";

test("C-QUESTION-01 recognizes modal input blocking independently of queued availability", () => {
  expect(blockingQuestionVisible(captured("blocking-modal-first.txt").text)).toBe(true);
  expect(blockingQuestionVisible(captured("blocking-modal-note.txt").text)).toBe(true);
  expect(blockingQuestionVisible("")).toBe(false);
  expect(blockingQuestionVisible("Question 1/2 (2 unanswered)\nOther footer")).toBe(false);
  expect(blockingQuestionVisible(captured("async-editor-first.txt").text)).toBe(false);
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
});
test("C-QUESTION-02 rejects partial, unknown, quoted and stale cursor layouts", () => {
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
test("C-QUESTION-02 validates full prompt and ordered option labels", () => {
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
test("C-QUESTION-02 checks exact native drafts without treating placeholders as answers", () => {
  const note: QuestionDefinition = {
    prompt: "ELWOOD_ASYNC_NOTE: What note?",
    options: [],
    selection: "none",
    textMode: "alternative",
    secret: false,
  };
  const free = questionView(captured("async-after-first.txt"))!;
  expect(draftMatches(free, note, "")).toBe(true);
  expect(draftMatches(free, note, "Not staged")).toBe(false);
  const typed = questionView(captured("async-editor-note.txt"))!;
  expect(draftMatches(typed, note, "ELWOOD_NOTE_74")).toBe(true);
  const modal = questionView(captured("blocking-modal-note.txt"))!;
  expect(draftMatches(modal, note, "ELWOOD_MODAL_NOTE_85")).toBe(true);
  expect(draftMatches({ ...modal, notes: false }, note, "")).toBe(false);
  expect(draftMatches({ ...modal, rawBody: [] }, note, "")).toBe(false);
  const color: QuestionDefinition = {
    ...note,
    prompt: "ELWOOD_ASYNC_COLOR: Which color?",
    options: [{ label: "Amber" }, { label: "Blue" }],
  };
  expect(draftMatches(questionView(captured("async-editor-first.txt"))!, color, "")).toBe(false);
  const other = questionView(
    frame(
      captured("async-editor-first.txt")
        .text.replace("  › 1. Amber", "    1. Amber")
        .replace("    3. Other", "  › 3. Other"),
    ),
  )!;
  expect(draftMatches(other, color, "")).toBe(true);
  expect(draftMatches({ ...other, rawBody: [] }, color, "")).toBe(false);
  const collision = { ...color, options: [{ label: "Other" }, { label: "Blue" }] };
  const explicit = {
    ...other,
    rawBody: other.rawBody.map((line) =>
      line.replace("› 3. Other", "› 3. Other (write an answer)"),
    ),
  };
  expect(draftMatches(explicit, collision, "")).toBe(true);
  const multi = questionView(
    frame(
      captured("async-editor-note.txt").text.replace("  ELWOOD_NOTE_74", "  Line one\n  Line two"),
    ),
  )!;
  expect(draftMatches(multi, note, "Line one\nLine two")).toBe(true);
});
