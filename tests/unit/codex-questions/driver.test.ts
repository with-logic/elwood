/** Confirmed native Codex answer routes and fail-closed guards (PRD §4). */
import { describe, expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { editorFrame, notesFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

const color: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_COLOR: Which color?",
  options: [{ label: "Amber" }, { label: "Blue" }],
  selection: "single",
  textMode: "alternative",
  supportsSecretInput: false,
};
const note: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_NOTE: What note?",
  options: [],
  selection: "none",
  textMode: "alternative",
  supportsSecretInput: false,
};
const first = captured("async-editor-first.txt");
const blue = captured("async-editor-blue.txt");
const emptyNote = editorFrame(captured("async-after-first.txt"), {
  editorLine: "  Type your answer",
  cursorLineBefore: "  ",
  dimmed: true,
});

describe("Codex guarded native question drivers", () => {
  test("accepts free text instead of an async suggestion", async () => {
    const other = editorFrame(
      frame(
        first.text.replace("  › 1. Amber", "    1. Amber").replace("    3. Other", "  › 3. Other"),
      ),
      { editorLine: "  › 3. Other", cursorLineBefore: "  › 3. ", dimmed: true },
    );
    const typed = editorFrame(frame(other.text.replace("› 3. Other", "› 3. Custom")), {
      editorLine: "  › 3. Custom",
      cursorLineBefore: "  › 3. Custom",
      dimmed: false,
    });
    const scripted = scriptedIo(blue, [
      { input: "\x1b[B", next: other },
      { input: "\x1b[200~Custom\x1b[201~", next: typed },
      { input: "\r" },
    ]);
    await answerQueued(
      [color, note],
      { optionIndexes: [], text: "Custom" },
      0,
      scripted.io,
      () => {},
    );
    expect(scripted.writes.at(-1)).toBe("\r");
  });
  test.each([
    { label: "missing frame", initial: undefined },
    { label: "ordinary composer", initial: frame("ordinary composer") },
    { label: "changed question count", initial: frame(first.text.replace("1 of 2", "1 of 3")) },
    {
      label: "foreign prompt",
      initial: frame(first.text.replaceAll(color.prompt, "Unrelated question")),
    },
    {
      label: "missing option caret",
      initial: frame(first.text.replace("› 1. Amber", "  1. Amber")),
    },
  ])("rejects $label without writes", async ({ initial }) => {
    const scripted = scriptedIo(initial, []);
    await expect(
      answerQueued([color, note], { optionIndexes: [0] }, 0, scripted.io, () => {}),
    ).rejects.toMatchObject({
      code: "question_answer_failed",
      message:
        "The native question answer could not be confirmed. Refresh pending questions and inspect the terminal before retrying.",
    });
    expect(scripted.writes).toEqual([]);
  });
  test("preserves preexisting human text and refuses unrelated repaint acknowledgement", async () => {
    const draft = editorFrame(frame(emptyNote.text.replace("Type your answer", "Human draft")), {
      editorLine: "  Human draft",
      cursorLineBefore: "  Human draft",
      dimmed: false,
    });
    const untouched = scriptedIo(draft, []);
    await expect(
      answerQueued([note], { optionIndexes: [], text: "Mine" }, 0, untouched.io, () => {}),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(untouched.writes).toEqual([]);
    const repaint = scriptedIo(emptyNote, [{ input: "\x1b[200~Mine\x1b[201~", next: emptyNote }]);
    await expect(
      answerQueued([note], { optionIndexes: [], text: "Mine" }, 0, repaint.io, () => {}),
    ).rejects.toThrow("Native fixture");
    expect(repaint.writes).not.toContain("\r");
    expect(repaint.writes).toEqual(["\x1b[200~Mine\x1b[201~"]);
  });
  test("preserves human notes on the second modal page after submitting the first", async () => {
    const modal = definitions("blocking-records.json");
    const firstModal = captured("blocking-modal-first.txt");
    const humanNotes = editorFrame(captured("blocking-modal-note.txt"), {
      editorLine: "  › ELWOOD_MODAL_NOTE_85",
      cursorLineBefore: "  › ELWOOD_MODAL_NOTE_85",
      dimmed: false,
    });
    expect(questionView(humanNotes)).toMatchObject({
      kind: "blocking",
      index: 1,
      count: 2,
      selected: 2,
      notes: true,
    });
    expect(matchesQuestion(questionView(humanNotes)!, modal[1]!)).toBe(true);
    const scripted = scriptedIo(firstModal, [
      { input: "\t", next: notesFrame(firstModal) },
      { input: "\r", next: humanNotes },
      { input: "\t" }, // Records an attempted takeover if the notes-ownership guard regresses.
    ]);
    let submissions = 0;
    await expect(
      answerBlocking(
        modal,
        [{ optionIndexes: [0] }, { optionIndexes: [], text: "Mine" }],
        scripted.io,
        () => submissions++,
      ),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(scripted.writes).toEqual(["\t", "\r"]);
    expect(submissions).toBe(0);
  });
});
