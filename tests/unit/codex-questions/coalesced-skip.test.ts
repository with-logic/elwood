/** Preserve native skip identity across a collapsed redraw (PRD §7A.5, C-QUESTION-04). */
import { expect, test } from "vitest";
import type { TerminalSnapshot } from "../../../src/terminal/headless.ts";
import { captured, fixture, frame, harness, records, scriptedIo } from "./helpers.ts";

test("C-QUESTION-04 a coalesced skip/collapse retires the skipped request after reopening", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const [skipped, remaining] = h.registry.list();
  expect(skipped).toBeDefined();
  expect(remaining).toBeDefined();
  const collapsed = JSON.parse(fixture("async-collapsed-after-escape.json")) as TerminalSnapshot;
  h.adapter.render({ ...collapsed, cursorRow: collapsed.cursorY });
  // A collapsed badge alone does not identify which request was removed.
  expect(h.registry.list()).toEqual([skipped, remaining]);
  const editor = captured("async-after-first.txt");
  h.adapter.render(editor);
  expect(h.registry.list()).toEqual([remaining]);
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: "unavailable",
    request: { id: skipped!.id },
  });
  const typed = frame(editor.text.replace("Type your answer", "ELWOOD_NOTE_74"));
  const scripted = scriptedIo(editor, [
    { input: "\x1b[200~ELWOOD_NOTE_74\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  await h.adapter.answer(remaining!, [{ optionIndexes: [], text: "ELWOOD_NOTE_74" }], scripted.io);
  expect(scripted.writes).toEqual(["\x1b[200~ELWOOD_NOTE_74\x1b[201~", "\r"]);
  expect(h.registry.list()).toEqual([remaining]);
  h.observe(native[4]);
  expect(h.registry.list()).toEqual([]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
});
