/** Pending rows must not steal a duplicate native question identity (PRD §4). */
import { expect, test, vi } from "vitest";
import * as questionFrames from "../../../src/codex/questions/frame.ts";
import { questionDefinitionCountLimit } from "../../../src/codex/questions/limits.ts";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, records, scriptedIo } from "./helpers.ts";

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

test("duplicate prompts preserve the remaining native answer route", async () => {
  const h = harness();
  const native = records("async-records.json");
  const original = JSON.stringify(native[1]);
  h.observe(
    JSON.parse(
      original
        .replaceAll("ELWOOD_ASYNC_COLOR: Which color?", "Q")
        .replaceAll("ELWOOD_ASYNC_NOTE: What note?", "Q"),
    ),
  );
  h.adapter.render(captured("async-badge.txt"));
  const [color, note] = h.registry.list();
  const current = pending("Q");
  h.adapter.render(current);
  h.observe(native[3]);
  expect(h.registry.list()).toEqual([note]);
  const typed = editorFrame(frame(current.text.replace("Type your answer", "Mine")), {
    editorLine: "  Mine",
    cursorLineBefore: "  Mine",
    dimmed: false,
  });
  const scripted = scriptedIo(current, [
    { input: "\x1b[200~Mine\x1b[201~", next: typed },
    { input: "\r" },
  ]);
  await h.adapter.answer(note!, [{ optionIndexes: [], text: "Mine" }], scripted.io);
  expect(scripted.writes).toEqual(["\x1b[200~Mine\x1b[201~", "\r"]);
  expect(h.events).toContainEqual(
    expect.objectContaining({ phase: "closed", reason: "answered", request: color }),
  );
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

test("pending unpublished units are excluded from later count publication", () => {
  const h = harness();
  h.observe(call("a", "ELWOOD_ASYNC_COLOR: Which color?", ["Amber", "Blue"]));
  h.observe(call("b", "ELWOOD_ASYNC_NOTE: What note?"));
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "secret",
      delivery: "async",
      questions: [{ title: "Secret", isSecret: true }],
    },
  });
  h.adapter.render(
    frame(captured("async-badge.txt").text.replace("? 2 questions", "? 3 questions")),
  );
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(
    editorFrame(captured("async-after-first.txt"), {
      editorLine: "  Type your answer",
      cursorLineBefore: "  ",
      dimmed: true,
    }),
  );
  expect(h.registry.list().map((request) => request.questions[0]?.prompt)).toEqual([
    "ELWOOD_ASYNC_NOTE: What note?",
  ]);
});

test("assistant quotations cannot hold an empty composer", () => {
  const h = harness();
  const current = frame(
    "• The screen says:\n  • Queued follow-up inputs\n  Question 1/2 (2 unanswered)\n\n› Ask Codex to do anything\n\n  GPT-6-Luna low",
  );
  const row = current.lines.findIndex((line) => line.startsWith("›"));
  h.adapter.render({ ...current, cursorVisible: true, cursorX: 2, cursorRow: row, cursorY: row });
  expect(h.adapter.blocksInput()).toBe(false);
});

test("ambiguous pending titles remain reserved until native identity acceptance", () => {
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
  h.observe({
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: queuedKey("first", 0), question: "Q", answer: "Mine" }])}</send_user_message_question_reply>`,
        },
      ],
    },
  });
  expect(h.registry.find(queuedKey("first", 0))).toBeUndefined();
  expect(h.registry.list()).toEqual([original[1]]);
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: "answered",
    request: original[0],
  });
  h.adapter.render({ ...empty, cursorX: 2, cursorRow: 0, cursorY: 0, cursorVisible: true });
  expect(h.registry.list()).toEqual([original[1]]);
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.registry.list()).toEqual([]);
});
test("unchanged working frames keep indexed native correlation bounded", () => {
  const h = harness();
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "many",
      delivery: "async",
      questions: Array.from({ length: questionDefinitionCountLimit }, () => ({
        title: "ELWOOD_ASYNC_COLOR: Which color?",
        options: ["Amber", "Blue"],
      })),
    },
  });
  const current = captured("async-editor-first.txt");
  const many = {
    ...current,
    text: current.text.replace("1 of 2", `1 of ${questionDefinitionCountLimit}`),
    lines: current.lines.map((line) =>
      line.replace("1 of 2", `1 of ${questionDefinitionCountLimit}`),
    ),
  };
  const matches = vi.spyOn(questionFrames, "matchesQuestion");
  try {
    h.adapter.render(many);
    h.adapter.render(many);
    expect(matches).toHaveBeenCalledTimes(2);
    expect(h.registry.list()).toHaveLength(questionDefinitionCountLimit);
  } finally {
    matches.mockRestore();
  }
});
