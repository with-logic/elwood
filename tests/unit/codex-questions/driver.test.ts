/** Confirmed native Codex answer routes and fail-closed guards (PRD §4). */
import { describe, expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, scriptedIo } from "./helpers.ts";

const color: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_COLOR: Which color?",
  options: [{ label: "Amber" }, { label: "Blue" }],
  selection: "single",
  textMode: "alternative",
  secret: false,
};
const note: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_NOTE: What note?",
  options: [],
  selection: "none",
  textMode: "alternative",
  secret: false,
};
const first = captured("async-editor-first.txt");
const blue = captured("async-editor-blue.txt");
const emptyNote = editorFrame(captured("async-after-first.txt"), {
  editorLine: "  Type your answer",
  cursorLineBefore: "  ",
  dimmed: true,
});
const secondNote = emptyNote.text.replace("⇧→ main prompt", "⇧→ prev question");

describe("Codex guarded native question drivers", () => {
  test("safely selects upwards and navigates second to first", async () => {
    const second = editorFrame(
      frame(
        secondNote.replace(
          "• Queued follow-up inputs\n \n",
          "• Queued follow-up inputs\n \n  2 of 2\n",
        ),
      ),
      { editorLine: "  Type your answer", cursorLineBefore: "  ", dimmed: true },
    );
    const scripted = scriptedIo(second, [
      { input: "\x1b[1;2C", next: blue },
      { input: "\x1b[A", next: first },
      { input: "\r" },
    ]);
    await answerQueued([color, note], { optionIndexes: [0] }, 0, scripted.io, () => {});
    expect(scripted.writes).toEqual(["\x1b[1;2C", "\x1b[A", "\r"]);
  });
  test("navigates forward and stages exact free text", async () => {
    const second = editorFrame(
      frame(
        secondNote.replace(
          "• Queued follow-up inputs\n \n",
          "• Queued follow-up inputs\n \n  2 of 2\n",
        ),
      ),
      { editorLine: "  Type your answer", cursorLineBefore: "  ", dimmed: true },
    );
    const typed = editorFrame(
      frame(second.text.replace("  Type your answer", "  ELWOOD_NOTE_74")),
      { editorLine: "  ELWOOD_NOTE_74", cursorLineBefore: "  ELWOOD_NOTE_74", dimmed: false },
    );
    const scripted = scriptedIo(first, [
      { input: "\x1b[1;2D", next: second },
      { input: "\x1b[200~ELWOOD_NOTE_74\x1b[201~", next: typed },
      { input: "\r" },
    ]);
    await answerQueued(
      [color, note],
      { optionIndexes: [], text: "ELWOOD_NOTE_74" },
      1,
      scripted.io,
      () => {},
    );
    expect(scripted.writes).toHaveLength(3);
  });
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
    undefined,
    frame("ordinary composer"),
    frame(first.text.replace("1 of 2", "1 of 3")),
    frame(first.text.replaceAll(color.prompt, "Unrelated question")),
    frame(first.text.replace("› 1. Amber", "  1. Amber")),
  ])("rejects missing, changed or unsupported layout without writes", async (initial) => {
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
  test("refuses a human-navigated modal notes stage", async () => {
    const scripted = scriptedIo(
      editorFrame(captured("blocking-modal-note.txt"), {
        editorLine: "  › ELWOOD_MODAL_NOTE_85",
        cursorLineBefore: "  › ELWOOD_MODAL_NOTE_85",
        dimmed: false,
      }),
      [],
    );
    await expect(
      answerBlocking(
        [{ ...note, prompt: "ELWOOD_MODAL_NOTE: What note?" }],
        [{ optionIndexes: [], text: "Mine" }],
        scripted.io,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
  });
});
