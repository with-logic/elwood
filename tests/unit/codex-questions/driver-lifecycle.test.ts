/** Native Codex question lifecycle and guarded answering (PRD §4). */
import { describe, expect, test } from "vitest";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, fixture, frame, records, scriptedIo } from "./helpers.ts";

const first = captured("async-editor-first.txt");
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
  test("submits grouped modal choice and alternative notes", async () => {
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
  test("aborting uncertain acceptance restores local skip reconciliation", async () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(first);
    const scripted = scriptedIo(first, [{ input: "\r" }]);
    await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], scripted.io);
    scripted.controller.abort();
    const skipped = JSON.parse(fixture("async-after-local-skip.json")) as { readonly text: string };
    h.adapter.render(frame(skipped.text));
    expect(h.registry.list()).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ reason: "unavailable" });
  });
});
