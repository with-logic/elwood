/** Caller cancellation cannot release dispatched native question ownership (PRD §4). */
import { expect, test, vi } from "vitest";
import { harness } from "./adapter-helpers.ts";
import {
  captured,
  emptyComposerFrame as emptyComposer,
  frame,
  records,
  scriptedIo,
} from "./helpers.ts";

test.each([
  "native answer",
  "turn end",
] as const)("abort after Enter holds the exact request through an empty composer until %s", async (closure) => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[1]);
  const first = captured("async-editor-first.txt");
  h.adapter.render(first);
  const original = h.registry.list()[0];
  if (!original) throw new Error("Missing published color question");
  const nativeKey = h.registry.keyFor(original.id);
  expect(nativeKey).toBeDefined();
  const scripted = scriptedIo(first, [{ input: "\r" }]);
  await h.adapter.answer(original, [{ optionIndexes: [0] }], scripted.io);
  scripted.controller.abort();
  h.adapter.render(emptyComposer());
  expect(h.registry.get(original.id)).toBe(original);
  expect(h.registry.find(nativeKey!)).toBe(original);
  expect(h.adapter.blocksInput()).toBe(true);
  expect(h.events.filter((edge) => edge.request === original).map((edge) => edge.phase)).toEqual([
    "raised",
  ]);
  h.observe(closure === "native answer" ? native[3] : { payload: { type: "turn_complete" } });
  expect(h.registry.find(nativeKey!)).toBeUndefined();
  expect(h.events.at(-1)).toMatchObject({
    phase: "closed",
    reason: closure === "native answer" ? "answered" : "unavailable",
    request: original,
  });
  h.adapter.render(emptyComposer());
  expect(h.registry.list()).toEqual([]);
  expect(h.adapter.blocksInput()).toBe(false);
  expect(scripted.writes).toEqual(["\r"]);
});

test("abort defers render notifications to the normal observer boundary", async () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  const first = captured("async-editor-first.txt");
  h.adapter.render(first);
  const original = h.registry.list()[0];
  if (!original) throw new Error("Missing published color question");
  const scripted = scriptedIo(first, [{ input: "\r" }]);
  let currentFrame = first;
  const readFrame = vi.fn(() => currentFrame);
  await h.adapter.answer(original, [{ optionIndexes: [0] }], {
    ...scripted.io,
    frame: readFrame,
  });
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "next",
      delivery: "async",
      questions: [{ title: "Later A" }, { title: "Later B" }],
    },
  });
  currentFrame = frame(captured("async-badge.txt").text.replace("? 2 questions", "? 4 questions"));
  const failure = new Error("later raised observer failed");
  let laterNotifications = 0;
  h.emitter.on("question", (edge) => {
    if (edge.phase === "raised" && edge.request.questions[0]?.prompt.startsWith("Later")) {
      if (laterNotifications++ === 0) throw failure;
    }
  });
  const beforeAbortReads = readFrame.mock.calls.length;
  scripted.controller.abort();
  expect(readFrame).toHaveBeenCalledTimes(beforeAbortReads);
  expect(laterNotifications).toBe(0);
  expect(h.registry.list()).toHaveLength(2);
  const report = vi.fn();
  expect(() => h.emitter.observeErrors(report, () => h.adapter.render(currentFrame))).not.toThrow();
  expect(laterNotifications).toBe(2);
  expect(h.registry.list().map((request) => request.questions[0]?.prompt)).toEqual([
    "ELWOOD_ASYNC_COLOR: Which color?",
    "ELWOOD_ASYNC_NOTE: What note?",
    "Later A",
    "Later B",
  ]);
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});
