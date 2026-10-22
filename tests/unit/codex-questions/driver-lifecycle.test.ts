/** Native Codex question lifecycle and guarded answering (PRD §4). */
import { describe, expect, test } from "vitest";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, records, scriptedIo } from "./helpers.ts";
import { snapshot } from "./snapshot-fixtures.ts";

const first = captured("async-editor-first.txt");
const blue = captured("async-editor-blue.txt");
const emptyNote = captured("async-after-first.txt");
const notes = (source: QuestionFrame, text = "Add notes") =>
  editorFrame(
    frame(
      source.text.replace(
        /^ {2}tab to add notes \| enter to submit (answer|all) \| ←\/→ to navigate questions \| esc to interrupt/m,
        `  › ${text}\n \n  tab or esc to clear notes | enter to submit $1`,
      ),
    ),
    {
      editorLine: `  › ${text}`,
      cursorLineBefore: text === "Add notes" ? "  › " : `  › ${text}`,
      dimmed: text === "Add notes",
    },
  );
describe("Codex native question lifecycle and driving", () => {
  test("opens badge and accepts one queued choice", async () => {
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
  test("submits grouped modal choice and alternative notes", async () => {
    const raw = records("blocking-records.json")[0];
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
        next: editorFrame(captured("blocking-modal-note.txt"), {
          editorLine: "  › ELWOOD_MODAL_NOTE_85",
          cursorLineBefore: "  › ELWOOD_MODAL_NOTE_85",
          dimmed: false,
        }),
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
  test("aborting uncertain acceptance retains the original request until native closure", async () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(first);
    const [color, note] = h.registry.list();
    expect(color).toBeDefined();
    expect(note).toBeDefined();
    const scripted = scriptedIo(first, [{ input: "\r" }]);
    await h.adapter.answer(color!, [{ optionIndexes: [0] }], scripted.io);
    scripted.controller.abort();
    const skipped = snapshot("async-after-local-skip.json");
    h.adapter.render(frame(skipped.text));
    expect(h.registry.list()).toEqual([color, note]);
    expect(h.adapter.blocksInput()).toBe(true);
    h.observe(native[3]);
    expect(h.registry.list()).toEqual([note]);
    expect(h.events.at(-1)).toMatchObject({ reason: "answered", request: color });
    expect(scripted.writes).toEqual(["\r"]);
  });
});
