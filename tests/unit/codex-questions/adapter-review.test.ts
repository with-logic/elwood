/** Reconcile native queue redraws without guessing completion (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, fixture, frame, records, scriptedIo } from "./helpers.ts";

const composer = () => ({
  ...frame("› Ask Codex to do anything\n\n  GPT-6-Luna low"),
  cursorX: 2,
  cursorY: 0,
  cursorRow: 0,
  cursorVisible: true,
});
const call = (id: string, title: string, isSecret = false) => ({
  payload: { type: "AgentMessage", id, delivery: "async", questions: [{ title, isSecret }] },
});
function editor(prompt: string) {
  const native = JSON.parse(fixture("async-after-local-skip.json")) as { text: string };
  return editorFrame(frame(native.text.replaceAll("ELWOOD_ASYNC_NOTE: What note?", prompt)), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
}
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
