/** Reconcile native queue redraws without guessing completion (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, emptyComposerFrame as composer, frame, records, scriptedIo } from "./helpers.ts";
import { queuedCall as call, queuedEditor as editor } from "./native-adapter-fixtures.ts";

test("unrelated spinner redraws cannot release opaque native reservations", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe(call("secret", "New", true));
  h.adapter.render(frame(captured("async-badge.txt").text.replace("2s", "3s")));
  h.adapter.render(composer());
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.adapter.blocksInput()).toBe(false);
});

test("an opaque question prevents count-only publication of another request", () => {
  const h = harness();
  h.observe(call("a", "A"));
  h.observe(call("secret", "Secret", true));
  h.adapter.render(
    frame(captured("async-badge.txt").text.replace("? 2 questions", "? 1 question")),
  );
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(editor("A"));
  expect(h.registry.list()).toHaveLength(1);
  expect(h.adapter.blocksInput()).toBe(true);
});

test("a coalesced skip and arrival preserve the sole remaining answer route", async () => {
  const h = harness();
  h.observe(call("a", "A"));
  h.adapter.render(editor("A"));
  const old = h.registry.list()[0]!;
  h.observe(call("b", "B"));
  const current = editor("B");
  h.adapter.render(current);
  const [request] = h.registry.list();
  expect(request?.questions[0]?.prompt).toBe("B");
  expect(h.events).toContainEqual(
    expect.objectContaining({
      phase: "closed",
      reason: "unavailable",
      request: old,
    }),
  );
  const typed = editorFrame(frame(current.text.replace("Type your answer", "Mine")), {
    editorLine: "  Mine",
    cursorLineBefore: "  Mine",
    dimmed: false,
  });
  const scripted = scriptedIo(current, [
    { input: "\x1b[200~Mine\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  await h.adapter.answer(request!, [{ optionIndexes: [], text: "Mine" }], scripted.io);
  expect(scripted.writes).toEqual(["\x1b[200~Mine\x1b[201~", "\r"]);
});

test("native pending submissions retain identity until transcript acceptance", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const [color, note] = h.registry.list();
  const pending = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  h.adapter.render(pending);
  h.adapter.render(pending);
  expect(h.registry.list()).toEqual([color, note]);
  const unavailable = scriptedIo(pending, []);
  await expect(
    h.adapter.answer(color!, [{ optionIndexes: [0] }], unavailable.io),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(unavailable.writes).toEqual([]);
  const typed = editorFrame(frame(pending.text.replace("Type your answer", "Mine")), {
    editorLine: "  Mine",
    cursorLineBefore: "  Mine",
    dimmed: false,
  });
  const scripted = scriptedIo(pending, [
    { input: "\x1b[200~Mine\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  await h.adapter.answer(note!, [{ optionIndexes: [], text: "Mine" }], scripted.io);
  expect(scripted.writes).toEqual(["\x1b[200~Mine\x1b[201~", "\r"]);
  h.observe(native[3]);
  expect(h.registry.list()).toEqual([note]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request: color });
});

test("abort after native pending submission cannot erase its later acceptance", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[1]);
  const first = captured("async-editor-first.txt");
  h.adapter.render(first);
  const color = h.registry.list()[0]!;
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: captured("async-editor-blue.txt") },
    { input: "\r", next: captured("async-after-first.txt") },
  ]);
  await h.adapter.answer(color, [{ optionIndexes: [1] }], scripted.io);
  scripted.controller.abort();
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toContain(color);
  h.observe(native[3]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request: color });
  expect(scripted.writes).toEqual(["\x1b[B", "\r"]);
});

test("quoted question chrome cannot keep a proven empty composer blocked", () => {
  const h = harness();
  const text =
    "› Explain this screen:\n  • Queued follow-up inputs\n  Question 1/2 (2 unanswered)\n\n• That is a question screen.\n\n› Ask Codex to do anything\n\n  GPT-6-Luna low";
  const current = frame(text);
  const cursorRow = current.lines.findLastIndex((line) => line.startsWith("› Ask"));
  h.adapter.render({ ...current, cursorX: 2, cursorRow, cursorY: cursorRow, cursorVisible: true });
  expect(h.adapter.blocksInput()).toBe(false);
});
