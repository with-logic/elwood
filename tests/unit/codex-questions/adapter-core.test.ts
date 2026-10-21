/** Core private adapter routing and native identity holds (PRD §4). */
import { expect, test } from "vitest";
import type { ValidatedQuestionAnswer } from "../../../src/core/questions/validate.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, emptyComposerFrame as empty, frame, records, scriptedIo } from "./helpers.ts";
import { queuedCall as call, queuedEditor as editor } from "./native-adapter-fixtures.ts";

test("publishes grouped modal questions and rejects writes without their native frame", async () => {
  const h = harness();
  h.observe(records("blocking-records.json")[0]);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const request = h.registry.list()[0]!;
  expect(request.questions).toHaveLength(2);
  const scripted = scriptedIo(undefined, []);
  await expect(
    h.adapter.answer(request, [{ optionIndexes: [0] }, { optionIndexes: [0] }], scripted.io),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});

test.each([
  false,
  true,
])("pending title ambiguity %s cannot release live native identities", async (duplicate) => {
  const h = harness();
  const native = records("async-records.json");
  const title = "ELWOOD_ASYNC_NOTE: What note?";
  h.observe(
    duplicate
      ? {
          payload: {
            type: "AgentMessage",
            id: "duplicates",
            delivery: "async",
            questions: [{ title }, { title }],
          },
        }
      : native[1],
  );
  h.adapter.render(captured("async-badge.txt"));
  const original = h.registry.list();
  const pending = captured("async-after-first.txt");
  const current = duplicate
    ? frame(pending.text.replaceAll("ELWOOD_ASYNC_COLOR: Which color?", title))
    : pending;
  h.adapter.render(current);
  h.adapter.render(current);
  if (!duplicate)
    h.adapter.render(
      frame(
        "• Working (3s • esc to interrupt)\n• Messages to be submitted after next tool call\n  ↳ > Unmatched",
      ),
    );
  h.adapter.render(empty());
  expect(h.registry.list()).toEqual(duplicate ? original : [original[0]]);
  expect(h.adapter.blocksInput()).toBe(true);
  const scripted = scriptedIo(undefined, []);
  await expect(h.adapter.answer(original[0]!, [], scripted.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(scripted.writes).toEqual([]);
  h.observe(duplicate ? { payload: { type: "turn_complete" } } : native[3]);
  expect(h.registry.list()).toEqual([]);
});

test.each([
  false,
  true,
])("coalesced replacement preserves routing when abort has frame %s", async (hasFrame) => {
  const h = harness();
  h.observe(call("a", "A"));
  h.adapter.render(editor("A"));
  const old = h.registry.list()[0]!;
  h.observe(call("b", "B"));
  const current = editor("B");
  h.adapter.render(current);
  const [request] = h.registry.list();
  expect(h.registry.get(old.id)).toBeUndefined();
  expect(request?.questions[0]?.prompt).toBe("B");
  const typed = editorFrame(frame(current.text.replace("Type your answer", "Mine")), {
    editorLine: "  Mine",
    cursorLineBefore: "  Mine",
    dimmed: false,
  });
  const scripted = scriptedIo(current, [
    { input: "\x1b[200~Mine\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  let disposed = false;
  await h.adapter.answer(request!, [{ optionIndexes: [], text: "Mine" }], {
    ...scripted.io,
    frame: () => (disposed && !hasFrame ? undefined : scripted.io.frame()),
  });
  h.adapter.render(empty());
  expect(h.registry.list()).toEqual([request]);
  disposed = true;
  scripted.controller.abort();
  h.adapter.render(empty());
  expect(h.registry.list()).toEqual([request]);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.registry.list()).toEqual([]);
  expect(scripted.writes).toEqual(["\x1b[200~Mine\x1b[201~", "\r"]);
});

test("opaque reservations outlive composer redraws and reject removed public authority", async () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const request = h.registry.list()[0]!;
  h.registry.close(request.id, "unavailable");
  const scripted = scriptedIo(undefined, []);
  await expect(h.adapter.answer(request, [], scripted.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  h.observe(call("secret", "Secret", true));
  h.adapter.render(empty());
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.adapter.blocksInput()).toBe(false);
  expect(scripted.writes).toEqual([]);
});

const invalidBatches: readonly (readonly ValidatedQuestionAnswer[])[] = [
  [],
  [{ optionIndexes: [0] }, { optionIndexes: [0] }],
  new Array<ValidatedQuestionAnswer>(1),
];
test.each(
  invalidBatches.map((answers) => ({ answers })),
)("rejects invalid direct queued batch $answers without writes", async ({ answers }) => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const scripted = scriptedIo(captured("async-editor-first.txt"), []);
  await expect(h.adapter.answer(h.registry.list()[0]!, answers, scripted.io)).rejects.toMatchObject(
    { code: "question_answer_failed" },
  );
  expect(scripted.writes).toEqual([]);
});

test("ambiguous or mismatched native positions do not publish an answer route", () => {
  const h = harness();
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "duplicates",
      delivery: "async",
      questions: [{ title: "Q" }, { title: "Q" }],
    },
  });
  h.adapter.render(editor("Q"));
  expect(h.registry.list()).toEqual([]);
  const mismatched = harness();
  mismatched.observe(records("async-records.json")[1]);
  mismatched.adapter.render(
    frame(captured("async-editor-first.txt").text.replace("1 of 2", "2 of 2")),
  );
  expect(mismatched.registry.list()).toEqual([]);
});
