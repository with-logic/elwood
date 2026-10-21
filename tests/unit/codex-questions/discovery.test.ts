/** Native Codex discovery and lifecycle contract (PRD §7A.5, C-QUESTION-01). */
import { describe, expect, test } from "vitest";
import { captured, event, frame, harness, records, scriptedIo } from "./helpers.ts";

describe("Codex native question lifecycle", () => {
  test("C-QUESTION-01 exposes independent queued questions only after native acceptance and badge", () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toEqual([]);
    h.observe(native[1]);
    h.adapter.render(captured("async-badge.txt"));
    const requests = h.registry.list();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      delivery: "queued",
      questions: [
        {
          prompt: "ELWOOD_ASYNC_COLOR: Which color?",
          selection: "single",
          textMode: "alternative",
          secret: false,
          options: [{ label: "Amber" }, { label: "Blue" }],
        },
      ],
    });
    expect(requests[1]?.questions[0]).toMatchObject({ selection: "none", options: [] });
    for (const item of native.slice(0, 3)) h.observe(item);
    h.adapter.render(captured("async-editor-first.txt"));
    expect(h.registry.list()).toEqual(requests);
    expect(h.events).toHaveLength(2);
    expect(h.adapter.blocksInput()).toBe(true);
    h.observe(native[3]);
    expect(h.registry.list()).toEqual([requests[1]]);
    h.observe(native[4]);
    expect(h.registry.list()).toEqual([]);
    expect(h.events.slice(2).map((edge) => edge.phase === "closed" && edge.reason)).toEqual([
      "answered",
      "answered",
    ]);
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toEqual([]);
  });
  test("C-QUESTION-01 accepts persisted async output even without its paginated mirror", () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[2]);
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toHaveLength(2);
  });
  test("C-QUESTION-01 confirms grouped modal request and whole native answer result", () => {
    const h = harness();
    const native = records("blocking-records.json");
    h.observe(native[0]);
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toHaveLength(0);
    h.adapter.render(captured("blocking-modal-first.txt"));
    expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.list()[0]).toMatchObject({
      delivery: "blocking",
      questions: [{ header: "Color", textMode: "additional" }, { header: "Note" }],
    });
    h.adapter.render(captured("blocking-modal-second.txt"));
    expect(h.events).toHaveLength(1);
    h.observe(native[1]);
    expect(h.registry.list()).toHaveLength(0);
    expect(h.events[1]).toMatchObject({ phase: "closed", reason: "answered" });
  });
  test("C-QUESTION-01 rejects invalid native calls and preserves unrelated surfaces", () => {
    const h = harness();
    for (const item of records("rejected-freeform-records.json")) h.observe(item);
    h.adapter.observe({ ...event({}), agent: "claude" });
    h.adapter.observe({ ...event({}), source: "hook" });
    h.observe(null);
    h.observe({ payload: { type: "function_call_output", call_id: 42 } });
    h.adapter.render(frame("A quoted question?\n› normal composer"));
    expect(h.registry.list()).toEqual([]);
    expect(h.adapter.blocksInput()).toBe(false);
  });
  test.each([
    "task_complete",
    "turn_aborted",
    "turn_failed",
  ])("C-QUESTION-01 retires live unanswered questions at %s", (type) => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(captured("async-badge.txt"));
    h.observe({ payload: { type } });
    expect(h.registry.list()).toEqual([]);
    h.observe(native[1]);
    h.adapter.render(captured("async-badge.txt"));
    expect(h.registry.list()).toEqual([]);
  });
  test("C-QUESTION-01 reconciles native local skip without inventing an answer", () => {
    const h = harness();
    const native = records("async-records.json");
    h.observe(native[0]);
    h.observe(native[1]);
    h.adapter.render(captured("async-editor-first.txt"));
    const second = h.registry.list()[1];
    h.adapter.render(captured("async-after-first.txt"));
    expect(h.registry.list()).toEqual([second]);
    expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable" });
  });
  test.each([
    undefined,
    "bad JSON",
    '{"answers":{}}',
    '{"answers":{"color":null}}',
    '{"answers":{"color":{"answers":[null,""]}}}',
    "request_user_input was cancelled before receiving a response",
  ])("C-QUESTION-01 rejects unconfirmed modal result %s", (output) => {
    const h = harness();
    h.observe(records("blocking-records.json")[0]);
    h.adapter.render(captured("blocking-modal-first.txt"));
    h.observe({
      payload: {
        type: "function_call_output",
        call_id: "call_8aaf11dc88ec4e7cb1d51793fea2de2c",
        output,
      },
    });
    expect(h.registry.list()).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({
      reason:
        typeof output === "string" && output.includes("cancelled") ? "cancelled" : "unavailable",
    });
  });
  test("C-QUESTION-02 stale adapter authority performs zero writes", async () => {
    const h = harness();
    const request = h.registry.publish("foreign", "queued", []);
    const { io, writes } = scriptedIo(undefined, []);
    await expect(h.adapter.answer(request, [], io)).rejects.toMatchObject({
      code: "question_answer_failed",
    });
    expect(writes).toEqual([]);
  });
});
