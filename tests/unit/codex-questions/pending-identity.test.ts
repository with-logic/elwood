/** Pending rows must not steal a duplicate native question identity (PRD §4). */
import { expect, test } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, records } from "./helpers.ts";

function pending(prompt: string) {
  return editorFrame(
    frame(
      captured("async-after-first.txt")
        .text.replaceAll("ELWOOD_ASYNC_COLOR: Which color?", prompt)
        .replaceAll("ELWOOD_ASYNC_NOTE: What note?", prompt),
    ),
    { editorLine: "  Type your answer", cursorLineBefore: "  ", dimmed: true },
  );
}
const call = (id: string, title: string, options?: readonly string[]) => ({
  payload: {
    type: "AgentMessage",
    id,
    delivery: "async",
    questions: [{ title, ...(options ? { options } : {}) }],
  },
});
test("an old pending echo cannot consume a new question with that title", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const [color, note] = h.registry.list();
  expect(color).toBeDefined();
  const oldKey = h.registry.keyFor(color!.id);
  expect(oldKey).toBeDefined();
  const current = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  h.adapter.render(current);
  h.observe(records("async-records.json")[3]);
  h.observe(call("new", "ELWOOD_ASYNC_COLOR: Which color?", ["Amber", "Blue"]));
  const badge = captured("async-badge.txt").text;
  const header = "• Queued follow-up inputs";
  h.adapter.render(
    frame(
      current.text.slice(0, current.text.lastIndexOf(header)) +
        badge.slice(badge.lastIndexOf(header)),
    ),
  );
  const replacement = h.registry.find(queuedKey("new", 0));
  expect(h.registry.find(oldKey!)).toBeUndefined();
  expect(h.registry.get(color!.id)).toBeUndefined();
  expect(replacement?.questions[0]?.prompt).toBe("ELWOOD_ASYNC_COLOR: Which color?");
  expect(h.registry.list()).toEqual([note, replacement]);
});
test("ambiguous pending titles remain reserved until the turn boundary", () => {
  const h = harness();
  h.observe(call("first", "Q"));
  h.observe(call("second", "Q"));
  h.adapter.render(captured("async-badge.txt"));
  const original = h.registry.list();
  const badge = captured("async-badge.txt").text;
  const header = "• Queued follow-up inputs";
  const current = pending("Q").text;
  h.adapter.render(
    frame(current.slice(0, current.lastIndexOf(header)) + badge.slice(badge.lastIndexOf(header))),
  );
  const empty = frame("› Ask Codex to do anything\n\n  GPT-6-Luna low");
  h.adapter.render({ ...empty, cursorX: 2, cursorRow: 0, cursorY: 0, cursorVisible: true });
  expect(h.registry.list()).toEqual(original);
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.registry.list()).toEqual([]);
});
