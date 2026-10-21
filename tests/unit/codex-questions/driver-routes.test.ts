/** Captured native queued and grouped answer write sequences (PRD §4). */
import { expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import { editorFrame, notesFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

test("opens the native badge before selecting a queued choice", async () => {
  const first = captured("async-editor-first.txt");
  const blue = captured("async-editor-blue.txt");
  const scripted = scriptedIo(captured("async-badge.txt"), [
    { input: "\x1b[1;2D", next: first },
    { input: "\x1b[B", next: blue },
    { input: "\r" },
  ]);
  let submitting = false;
  await answerQueued(
    definitions("async-records.json"),
    { optionIndexes: [1] },
    0,
    scripted.io,
    () => {
      submitting = true;
    },
  );
  expect(scripted.writes).toEqual(["\x1b[1;2D", "\x1b[B", "\r"]);
  expect(submitting).toBe(true);
});

test("stages every grouped modal answer before the final submission", async () => {
  const first = captured("blocking-modal-first.txt");
  const blue = frame(
    first.text.replace("  › 1. Amber", "    1. Amber").replace("    2. Blue", "  › 2. Blue"),
  );
  const second = captured("blocking-modal-second.txt");
  const short = frame(
    second.text
      .replace("  › 1. Standard", "    1. Standard")
      .replace("    2. Short", "  › 2. Short"),
  );
  const other = captured("blocking-modal-other.txt");
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: blue },
    { input: "\t", next: notesFrame(blue) },
    { input: "\r", next: second },
    { input: "\x1b[B", next: short },
    { input: "\x1b[B", next: other },
    { input: "\t", next: notesFrame(other) },
    {
      input: "\x1b[200~ELWOOD_MODAL_NOTE_85\x1b[201~",
      next: editorFrame(captured("blocking-modal-note.txt"), {
        editorLine: "  › ELWOOD_MODAL_NOTE_85",
        cursorLineBefore: "  › ELWOOD_MODAL_NOTE_85",
        dimmed: false,
      }),
    },
    { input: "\r" },
  ]);
  const submissionWrites: number[] = [];
  await answerBlocking(
    definitions("blocking-records.json"),
    [{ optionIndexes: [1] }, { optionIndexes: [], text: "ELWOOD_MODAL_NOTE_85" }],
    scripted.io,
    () => submissionWrites.push(scripted.writes.length),
  );
  expect(scripted.writes).toEqual([
    "\x1b[B",
    "\t",
    "\r",
    "\x1b[B",
    "\x1b[B",
    "\t",
    "\x1b[200~ELWOOD_MODAL_NOTE_85\x1b[201~",
    "\r",
  ]);
  expect(submissionWrites).toEqual([7]);
});

test("a listed Other label keeps the native free-text alternative distinct", async () => {
  const questions = definitions("async-records.json").map((question) => ({
    ...question,
    options: question.options.map((option) => ({
      ...option,
      label: option.label === "Amber" ? "Other" : option.label,
    })),
  }));
  const current = frame(
    captured("async-editor-first.txt")
      .text.replace("1. Amber", "1. Other")
      .replace("3. Other", "3. Other (write an answer)"),
  );
  const scripted = scriptedIo(current, [{ input: "\r" }]);
  await answerQueued(questions, { optionIndexes: [0] }, 0, scripted.io, () => {});
  expect(scripted.writes).toEqual(["\r"]);
});

test("a modal notes page already owned by a human receives no input", async () => {
  const modal = definitions("blocking-records.json");
  const notes = editorFrame(
    frame(
      captured("blocking-modal-first.txt").text.replace(
        "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
        "  › Add notes\n\n  tab or esc to clear notes | enter to submit answer",
      ),
    ),
    { editorLine: "  › Add notes", cursorLineBefore: "  › ", dimmed: true },
  );
  const scripted = scriptedIo(notes, []);
  await expect(
    answerBlocking(modal, [{ optionIndexes: [0] }, { optionIndexes: [0] }], scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});

test("quoted expected text below a foreign heading grants no answer authority", async () => {
  const queued = definitions("async-records.json");
  const text = captured("async-editor-first.txt")
    .text.replaceAll(queued[0]!.prompt, "Foreign heading")
    .replace("  enter submit", `  ${queued[0]!.prompt}\n\n  enter submit`);
  const scripted = scriptedIo(frame(text), []);
  await expect(
    answerQueued(queued, { optionIndexes: [0] }, 0, scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
