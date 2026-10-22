/** Native choice editors accept queued alternatives and selected modal notes (PRD §4). */
import { expect, test, vi } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import { editorFrame, notesFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

test("a queued question with choices submits its native Other text", async () => {
  const questions = definitions("async-records.json");
  const first = captured("async-editor-first.txt");
  const other = editorFrame(
    frame(
      first.text.replace("  › 1. Amber", "    1. Amber").replace("    3. Other", "  › 3. Other"),
    ),
    { editorLine: "  › 3. Other", cursorLineBefore: "  › 3. ", dimmed: true },
  );
  const text = "ELWOOD_CUSTOM_COLOR";
  const typed = editorFrame(frame(other.text.replace("  › 3. Other", `  › 3. ${text}`)), {
    editorLine: `  › 3. ${text}`,
    cursorLineBefore: `  › 3. ${text}`,
    dimmed: false,
  });
  const paste = `\x1b[200~${text}\x1b[201~`;
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: captured("async-editor-blue.txt") },
    { input: "\x1b[B", next: other },
    { input: paste, next: typed },
    { input: "\r" },
  ]);
  const submitting = vi.fn(() => {
    expect(questionView(scripted.io.frame()!)?.selected).toBe(2);
    expect(scripted.writes).toEqual(["\x1b[B", "\x1b[B", paste]);
  });
  await answerQueued(questions, { optionIndexes: [], text }, 0, scripted.io, submitting);
  expect(scripted.writes).toEqual(["\x1b[B", "\x1b[B", paste, "\r"]);
  expect(submitting).toHaveBeenCalledOnce();
});

test("a selected modal choice submits its associated notes", async () => {
  const questions = [definitions("blocking-records.json")[0]!];
  const first = frame(
    captured("blocking-modal-first.txt").text.replace(
      "Question 1/2 (2 unanswered)",
      "Question 1/1 (1 unanswered)",
    ),
  );
  const blue = frame(
    first.text.replace("  › 1. Amber", "    1. Amber").replace("    2. Blue", "  › 2. Blue"),
  );
  const text = "ELWOOD_BLUE_NOTE";
  const paste = `\x1b[200~${text}\x1b[201~`;
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: blue },
    { input: "\t", next: notesFrame(blue) },
    { input: paste, next: notesFrame(blue, text) },
    { input: "\r" },
  ]);
  const submitting = vi.fn(() => {
    expect(questionView(scripted.io.frame()!)?.selected).toBe(1);
    expect(scripted.writes).toEqual(["\x1b[B", "\t", paste]);
  });
  await answerBlocking(questions, [{ optionIndexes: [1], text }], scripted.io, submitting);
  expect(scripted.writes).toEqual(["\x1b[B", "\t", paste, "\r"]);
  expect(submitting).toHaveBeenCalledOnce();
});
