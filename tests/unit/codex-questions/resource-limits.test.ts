/** Bounded Codex question metadata and redraw work (PRD §7A.5, C-QUESTION-05). */
import { expect, test, vi } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { captured, event, frame, harness, records, scriptedIo } from "./helpers.ts";

const mib = 1024 * 1024;
function native(id: string, count = 1, title = "Question") {
  return {
    payload: {
      type: "AgentMessage",
      id,
      delivery: "async",
      questions: Array.from({ length: count }, () => ({ title })),
    },
  };
}
function stateHarness() {
  const h = harness();
  const state = new CodexQuestionCandidates(h.registry);
  const observe = (raw: unknown) => state.observe(event(raw));
  const expose = () => {
    for (const candidate of state.candidates.values()) state.publish(candidate);
  };
  return { ...h, state, observe, expose };
}
function disabledSnapshot(h: ReturnType<typeof stateHarness>) {
  const before = [h.state.candidates.size, h.registry.list()];
  h.observe(native("later"));
  h.state.close("after-disabled", "answered");
  h.expose();
  return [...before, h.registry.list()];
}
test("C-QUESTION-05 unchanged high-volume redraws publish once, including throwing observers", () => {
  const h = harness();
  h.emitter.on("question", () => {
    throw new Error("observer");
  });
  h.observe(native("full", 256));
  const badge = frame(captured("async-badge.txt").text.replace("? 2 questions", "? 256 questions"));
  const publish = vi.spyOn(h.registry, "publish");
  for (let index = 0; index < 1000; index++) h.adapter.render(badge);
  expect(publish).toHaveBeenCalledTimes(256);
  expect(h.registry.list()).toHaveLength(256);
});
test("C-QUESTION-05 accepts 256 pending native units then disables without reopening", () => {
  const h = stateHarness();
  h.observe(native("full", 256));
  h.expose();
  expect(h.registry.list()).toHaveLength(256);
  const stale = h.state.candidates.values().next().value!;
  h.observe(native("overflow"));
  h.state.publish(stale);
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
  expect(h.events.slice(256)).toHaveLength(256);
  expect(
    h.events.slice(256).every((edge) => edge.phase === "closed" && edge.reason === "unavailable"),
  ).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  h.observe(native("full", 256));
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("C-QUESTION-05 charges aggregate UTF-8 definitions and native identities", () => {
  for (const identity of [false, true]) {
    const h = stateHarness();
    const large = "é".repeat(140_000);
    for (let index = 0; index < 4; index++) {
      h.observe(native(identity ? `${index}${large}` : String(index), 1, identity ? "Q" : large));
    }
    expect(disabledSnapshot(h)).toEqual([0, [], []]);
  }
});
test("C-QUESTION-05 subtracts replaced and retired candidate metadata from the budget", () => {
  const h = stateHarness();
  const large = "é".repeat(140_000);
  h.observe(native("first", 1, large));
  h.observe(native("first", 1, "Small"));
  h.state.close(queuedKey("first", 0), "answered");
  for (let index = 0; index < 3; index++) h.observe(native(String(index), 1, large));
  h.expose();
  expect(h.registry.list()).toHaveLength(3);
});
test.each([
  "message-count",
  "call-count",
  "call-bytes",
  "message-bytes",
  "identity-bytes",
])("C-QUESTION-05 fails closed on oversized input before normalization: %s", (kind) => {
  const h = stateHarness();
  h.observe(native("existing"));
  h.expose();
  const call = {
    type: "function_call",
    name: "request_user_input_async",
    call_id: "oversized",
    arguments: "",
  };
  if (kind === "message-count") h.observe(native("oversized", 257));
  if (kind === "call-count")
    h.observe({
      payload: {
        ...call,
        arguments: JSON.stringify({
          questions: Array.from({ length: 257 }, () => ({ title: "Q" })),
        }),
      },
    });
  if (kind === "call-bytes")
    h.observe({ payload: { ...call, arguments: "é".repeat(mib / 2 + 1) } });
  if (kind === "message-bytes") h.observe(native("oversized", 1, "é".repeat(mib / 2)));
  if (kind === "identity-bytes") h.observe(native("é".repeat(mib / 2), 1));
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("C-QUESTION-05 retains 4096 tombstones and fails closed instead of evicting one", () => {
  const h = stateHarness();
  for (let index = 0; index < 4096; index++) h.state.close(`retired-${index}`, "answered");
  h.observe(native("allowed"));
  h.expose();
  expect(h.registry.list()).toHaveLength(1);
  h.state.close("one-too-many", "answered");
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("C-QUESTION-05 bounds retired UTF-8 key bytes and deduplicates replayed tombstones", () => {
  const h = stateHarness();
  const key = "é".repeat(mib / 4);
  h.state.close(key, "answered");
  h.state.close(key, "answered");
  h.observe(native("allowed"));
  h.expose();
  expect(h.registry.list()).toHaveLength(1);
  h.state.close(`${key}x`, "answered");
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("C-QUESTION-05 overflow preserves native input hold then releases at a cleared composer", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe(native("oversized", 257));
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(captured("async-editor-first.txt"));
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  const composer = frame("› Ask Codex to do anything\n\n  GPT-6-Luna low");
  h.adapter.render({ ...composer, cursorX: 2, cursorRow: 0 });
  expect(h.adapter.blocksInput()).toBe(false);
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toEqual([]);
});

test("C-QUESTION-05 unmeasurable nested input fails closed without escaping the observer", () => {
  const h = stateHarness();
  h.observe(native("existing"));
  h.expose();
  const nested = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
  h.observe({
    payload: {
      type: "function_call",
      name: "request_user_input_async",
      call_id: "nested",
      arguments: `{"questions":[{"title":"Q","unknown":${nested}}]}`,
    },
  });
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});

test("C-QUESTION-05 invalid metadata has no candidate cost and does not disable later questions", () => {
  const h = stateHarness();
  const call = { type: "function_call", name: "request_user_input_async" };
  h.observe({ payload: call });
  h.observe({ payload: { ...call, arguments: '{"questions":[{"title":"Q"}]}' } });
  h.observe(native("valid"));
  h.expose();
  expect(h.registry.list()).toHaveLength(1);
});
test("C-QUESTION-02 removed registry authority rejects answers without scanning candidates", async () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const request = h.registry.list()[0]!;
  h.registry.close(request.id, "unavailable");
  const scripted = scriptedIo(undefined, []);
  await expect(h.adapter.answer(request, [], scripted.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(scripted.writes).toEqual([]);
});
