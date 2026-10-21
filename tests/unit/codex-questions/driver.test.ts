/** Confirmed native Codex answer routes and fail-closed guards (PRD §7A.5). */
import { describe, expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured, frame, harness, records, scriptedIo } from "./helpers.ts";

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
const emptyNote = captured("async-after-first.txt");
const secondNote = emptyNote.text.replace("⇧→ main prompt", "⇧→ prev question");
const notes = (source: QuestionFrame, text = "Add notes") =>
  frame(
    source.text.replace(
      /tab to add notes \| enter to submit (answer|all) \| ←\/→ to navigate questions \| esc to interrupt/,
      `› ${text}\n \n  tab or esc to clear notes | enter to submit $1`,
    ),
  );

describe("Codex guarded native question drivers", () => {
  test("C-QUESTION-02 opens badge and accepts one queued choice", async () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(captured("async-badge.txt"));
    const scripted = scriptedIo(captured("async-badge.txt"), [
      { input: "\x1b[1;2D", next: first },
      { input: "\x1b[B", next: blue },
      { input: "\r" },
    ]);
    await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [1] }], scripted.io);
    expect(scripted.writes).toEqual(["\x1b[1;2D", "\x1b[B", "\r"]);
    h.adapter.render(first);
    h.adapter.render(emptyNote);
    expect(h.registry.list()).toHaveLength(2); // submitting Enter is not an acknowledgement
    h.observe(native[3]);
    expect(h.registry.list()).toHaveLength(1);
  });
  test("C-QUESTION-02 safely selects upwards and navigates second to first", async () => {
    const second = frame(
      secondNote.replace(
        "• Queued follow-up inputs\n \n",
        "• Queued follow-up inputs\n \n  2 of 2\n",
      ),
    );
    const scripted = scriptedIo(second, [
      { input: "\x1b[1;2C", next: blue },
      { input: "\x1b[A", next: first },
      { input: "\r" },
    ]);
    await answerQueued([color, note], { optionIndexes: [0] }, 0, scripted.io, () => {});
    expect(scripted.writes).toEqual(["\x1b[1;2C", "\x1b[A", "\r"]);
  });
  test("C-QUESTION-02 navigates forward and stages exact free text", async () => {
    const second = frame(
      secondNote.replace(
        "• Queued follow-up inputs\n \n",
        "• Queued follow-up inputs\n \n  2 of 2\n",
      ),
    );
    const typed = frame(second.text.replace("  Type your answer", "  ELWOOD_NOTE_74"));
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
  test("C-QUESTION-02 accepts free text instead of an async suggestion", async () => {
    const other = frame(
      first.text.replace("  › 1. Amber", "    1. Amber").replace("    3. Other", "  › 3. Other"),
    );
    const typed = frame(other.text.replace("› 3. Other", "› 3. Custom"));
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
  test("C-QUESTION-02 submits grouped modal choice and alternative notes", async () => {
    const raw = records("blocking-records.json")[0] as {
      readonly payload: Record<string, unknown>;
    };
    const h = harness();
    h.observe(raw);
    const modalFirst = captured("blocking-modal-first.txt");
    const modalBlue = frame(
      modalFirst.text.replace("  › 1. Amber", "    1. Amber").replace("    2. Blue", "  › 2. Blue"),
    );
    const modalSecond = captured("blocking-modal-second.txt");
    const short = frame(
      modalSecond.text
        .replace("  › 1. Standard", "    1. Standard")
        .replace("    2. Short", "  › 2. Short"),
    );
    const other = captured("blocking-modal-other.txt");
    const scripted = scriptedIo(modalFirst, [
      { input: "\x1b[B", next: modalBlue },
      { input: "\t", next: notes(modalBlue) },
      { input: "\r", next: modalSecond },
      { input: "\x1b[B", next: short },
      { input: "\x1b[B", next: other },
      { input: "\t", next: notes(other) },
      {
        input: "\x1b[200~ELWOOD_MODAL_NOTE_85\x1b[201~",
        next: captured("blocking-modal-note.txt"),
      },
      { input: "\r" },
    ]);
    h.adapter.render(modalFirst);
    await h.adapter.answer(
      h.registry.list()[0]!,
      [{ optionIndexes: [1] }, { optionIndexes: [], text: "ELWOOD_MODAL_NOTE_85" }],
      scripted.io,
    );
    expect(scripted.writes.filter((input) => input === "\r")).toHaveLength(2);
  });
  test("C-QUESTION-02 aborting uncertain acceptance restores local skip reconciliation", async () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(first);
    const scripted = scriptedIo(first, [{ input: "\r" }]);
    await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], scripted.io);
    scripted.controller.abort();
    h.adapter.render(emptyNote);
    expect(h.registry.list()).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ reason: "unavailable" });
  });
  test.each([
    undefined,
    frame("ordinary composer"),
    frame(first.text.replace("1 of 2", "1 of 3")),
    frame(first.text.replaceAll(color.prompt, "Unrelated question")),
    frame(first.text.replace("› 1. Amber", "  1. Amber")),
  ])("C-QUESTION-02 rejects missing, changed or unsupported layout without writes", async (initial) => {
    const scripted = scriptedIo(initial, []);
    await expect(
      answerQueued([color, note], { optionIndexes: [0] }, 0, scripted.io, () => {}),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(scripted.writes).toEqual([]);
  });
  test("C-QUESTION-02 preserves preexisting human text and refuses unrelated repaint acknowledgement", async () => {
    const draft = frame(emptyNote.text.replace("Type your answer", "Human draft"));
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
  });
  test("C-QUESTION-02 refuses a human-navigated modal notes stage", async () => {
    const scripted = scriptedIo(captured("blocking-modal-note.txt"), []);
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
