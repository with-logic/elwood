/** Native withdrawal, replacement and uncertain submission edges (PRD §7A.5). */
import { expect, test } from "vitest";
import { captured, frame, harness, records } from "./helpers.ts";

test("C-QUESTION-01 semantic native replacement invalidates old public answer authority", () => {
  const h = harness();
  const native = records("blocking-records.json")[0] as {
    readonly payload: Record<string, unknown>;
  };
  h.observe(native);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const previous = h.registry.list()[0];
  const changed = {
    ...native,
    payload: {
      ...native.payload,
      arguments: String(native.payload["arguments"]).replace("Warm", "New description"),
    },
  };
  h.observe(changed);
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(
    frame(captured("blocking-modal-first.txt").text.replace("Warm", "New description")),
  );
  expect(h.registry.list()[0]?.id).not.toBe(previous?.id);
  expect(h.events[1]).toMatchObject({ phase: "closed", reason: "unavailable" });
});
test("C-QUESTION-01 a complete live composer retires locally removed queued questions", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-badge.txt"));
  const composer = frame("› Ask Codex to do anything\n\n  GPT-6-Luna low");
  h.adapter.render(composer);
  expect(h.registry.list()).toHaveLength(2); // stale cursor cannot clear
  h.adapter.render({ ...composer, cursorX: 2, cursorY: 0, cursorRow: 0 });
  expect(h.registry.list()).toEqual([]);
  expect(
    h.events.slice(2).every((event) => event.phase === "closed" && event.reason === "unavailable"),
  ).toBe(true);
});
test("C-QUESTION-01 an incomplete composer and ambiguous editor preserve availability", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const requests = h.registry.list();
  h.adapter.render(frame("Question 1/2 (2 unanswered)\npartial native frame"));
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render({ ...frame("› Ask Codex to do anything"), cursorX: 2, cursorRow: 0 });
  expect(h.registry.list()).toEqual(requests);
  h.adapter.render(
    frame(
      captured("async-editor-first.txt")
        .text.replace("1 of 2", "1 of 3")
        .replaceAll("ELWOOD_ASYNC_COLOR: Which color?", "Unknown"),
    ),
  );
  expect(h.registry.list()).toEqual(requests);
});
test("C-QUESTION-01 a rejected async output never creates native availability", () => {
  const h = harness();
  const native = records("async-records.json")[0] as {
    readonly payload: { readonly call_id: string };
  };
  h.observe(native);
  h.observe({
    payload: {
      type: "function_call_output",
      call_id: native.payload.call_id,
      output: "Request rejected",
    },
  });
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toEqual([]);
});
test("C-QUESTION-01 an external answer can precede discovery without reopening", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[3]);
  h.observe(native[4]);
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toEqual([]);
  h.observe({ payload: { type: "turn_complete" } });
});
test("C-QUESTION-01 throwing observers cannot strand independent native requests", () => {
  const h = harness();
  const native = records("async-records.json");
  h.emitter.on("question", () => {
    throw new Error("question observer");
  });
  h.emitter.on("activity", () => {
    throw new Error("activity observer");
  });
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toHaveLength(2);
  h.observe({ payload: { type: "task_complete" } });
  expect(h.registry.list()).toEqual([]);
});
