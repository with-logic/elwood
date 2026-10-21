/** Core native branch witnesses retain guarded queued and grouped routes (PRD §4). */
import { expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { editorFrame, notesFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

const queued = definitions("async-records.json");
const modal = definitions("blocking-records.json");
const first = captured("async-editor-first.txt");
const blue = captured("async-editor-blue.txt");
const second = editorFrame(
  frame(
    captured("async-after-first.txt")
      .text.replace("• Queued follow-up inputs\n \n", "• Queued follow-up inputs\n \n  2 of 2\n")
      .replace("⇧→ main prompt", "⇧→ prev question"),
  ),
  {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  },
);
const typed = editorFrame(frame(second.text.replace("  Type your answer", "  ELWOOD_NOTE_74")), {
  editorLine: "  ELWOOD_NOTE_74",
  cursorLineBefore: "  ELWOOD_NOTE_74",
  dimmed: false,
});

test("core queued navigation and grouped native answers complete through guarded writes", async () => {
  let submissions = 0;
  const submitting = () => submissions++;
  const badge = scriptedIo(captured("async-badge.txt"), [
    { input: "\x1b[1;2D", next: first },
    { input: "\r" },
  ]);
  await answerQueued(queued, { optionIndexes: [0] }, 0, badge.io, submitting);
  expect(badge.writes).toHaveLength(2);
  const backwards = scriptedIo(second, [
    { input: "\x1b[1;2C", next: blue },
    { input: "\x1b[A", next: first },
    { input: "\r" },
  ]);
  await answerQueued(queued, { optionIndexes: [0] }, 0, backwards.io, submitting);
  expect(backwards.writes).toHaveLength(3);
  const forwards = scriptedIo(first, [
    { input: "\x1b[1;2D", next: second },
    { input: "\x1b[200~ELWOOD_NOTE_74\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  await answerQueued(
    queued,
    { optionIndexes: [], text: "ELWOOD_NOTE_74" },
    1,
    forwards.io,
    submitting,
  );
  expect(forwards.writes).toHaveLength(3);
  const firstModal = captured("blocking-modal-first.txt");
  const secondModal = captured("blocking-modal-second.txt");
  const short = frame(
    secondModal.text
      .replace("  › 1. Standard", "    1. Standard")
      .replace("    2. Short", "  › 2. Short"),
  );
  const other = captured("blocking-modal-other.txt");
  const grouped = scriptedIo(firstModal, [
    { input: "\t", next: notesFrame(firstModal) },
    { input: "\r", next: secondModal },
    { input: "\x1b[B", next: short },
    { input: "\x1b[B", next: other },
    { input: "\t", next: notesFrame(other) },
    {
      input: "\x1b[200~ELWOOD_MODAL_NOTE_85\x1b[201~",
      next: notesFrame(other, "ELWOOD_MODAL_NOTE_85"),
    },
    { input: "\r" },
  ]);
  await answerBlocking(
    modal,
    [{ optionIndexes: [0] }, { optionIndexes: [], text: "ELWOOD_MODAL_NOTE_85" }],
    grouped.io,
    submitting,
  );
  expect(grouped.writes).toHaveLength(7);
  expect(submissions).toBe(4);
});

test.each([
  "missing queued frame",
  "missing modal frame",
  "missing selector",
  "human draft",
])("%s refuses preparation before native input", async (scenario) => {
  let initial: QuestionFrame | undefined;
  if (scenario === "missing selector")
    initial = frame(first.text.replace("› 1. Amber", "  1. Amber"));
  if (scenario === "human draft")
    initial = editorFrame(
      frame(captured("async-after-first.txt").text.replace("Type your answer", "Human draft")),
      {
        editorLine: "  Human draft",
        cursorLineBefore: "  Human draft",
        dimmed: false,
      },
    );
  const scripted = scriptedIo(initial, []);
  const result =
    scenario === "missing modal frame"
      ? answerBlocking(
          modal,
          [{ optionIndexes: [0] }, { optionIndexes: [0] }],
          scripted.io,
          () => {},
        )
      : answerQueued(
          scenario === "human draft" ? [queued[1]!] : queued,
          { optionIndexes: [], text: "Mine" },
          0,
          scripted.io,
          () => {},
        );
  await expect(result).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
