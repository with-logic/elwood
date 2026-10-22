/** Bound Codex metadata and retired-identity resource budgets (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import * as questionDefinitions from "../../../src/codex/questions/definitions.ts";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { isRecord } from "../../../src/core/predicates.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { harness } from "./adapter-helpers.ts";
import { setup } from "./candidate-helpers.ts";
import { captured, emptyComposerFrame, event, records } from "./helpers.ts";

import { native, oversizedInputKinds, oversizedQuestionInput } from "./resource-inputs.ts";

afterEach(() => vi.restoreAllMocks());
const parseQuestions = questionDefinitions.parseQuestions;
const mib = 1024 * 1024;
function stateHarness() {
  const h = setup();
  const { state } = h;
  const observe = (raw: unknown) => state.observe(event(raw));
  const expose = () => {
    for (const candidate of state.candidates.values()) state.publish(candidate);
  };
  return { ...h, observe, expose };
}
function disabledSnapshot(h: ReturnType<typeof stateHarness>) {
  const before = [h.state.candidates.size, h.registry.list()];
  h.observe(native("later"));
  h.state.close("after-disabled", "answered");
  h.expose();
  return [...before, h.registry.list()];
}
test("accepts 256 pending native units then disables without reopening", () => {
  const h = stateHarness();
  const events: ElwoodQuestionEvent[] = [];
  h.registry.onEvent((edge) => events.push(edge));
  h.observe(native("full", 256));
  h.expose();
  expect(h.registry.list()).toHaveLength(256);
  const stale = h.state.candidates.values().next().value!;
  h.observe(native("overflow"));
  h.state.publish(stale);
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
  expect(events.slice(256)).toHaveLength(256);
  expect(
    events.slice(256).every((edge) => edge.phase === "closed" && edge.reason === "unavailable"),
  ).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  h.observe(native("full", 256));
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("charges aggregate UTF-8 definitions and native identities", () => {
  for (const identity of [false, true]) {
    const h = stateHarness();
    const large = "é".repeat(140_000);
    for (let index = 0; index < 4; index++) {
      h.observe(native(identity ? `${index}${large}` : String(index), 1, identity ? "Q" : large));
    }
    expect(disabledSnapshot(h)).toEqual([0, [], []]);
  }
});
test("subtracts replaced and retired candidate metadata from the budget", () => {
  const h = stateHarness();
  const large = "é".repeat(140_000);
  h.observe(native("first", 1, large));
  h.observe(native("first", 1, "Small"));
  h.state.close(queuedKey("first", 0), "answered");
  for (let index = 0; index < 3; index++) h.observe(native(String(index), 1, large));
  h.expose();
  expect(h.registry.list()).toHaveLength(3);
});
test.each(oversizedInputKinds)("rejects oversized input before normalization: %s", (kind) => {
  const h = stateHarness();
  h.observe(native("existing"));
  h.expose();
  const normalizationReads = vi.fn();
  const normalize = vi
    .spyOn(questionDefinitions, "parseQuestions")
    .mockImplementation((value, queued, identity) => {
      const first: unknown = Array.isArray(value) ? value[0] : undefined;
      if (isRecord(first)) {
        const title = first["title"];
        // Let size accounting serialize the title without reading the normalization-only getter.
        Object.defineProperty(first, "toJSON", { value: () => ({ title }) });
        Object.defineProperty(first, "title", {
          get: () => {
            normalizationReads();
            return title;
          },
        });
      }
      return parseQuestions(value, queued, identity);
    });
  h.observe(oversizedQuestionInput(kind));
  expect(normalize).toHaveBeenCalledTimes(kind === "call-bytes" ? 0 : 1);
  expect(normalizationReads).not.toHaveBeenCalled();
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("retains 4096 tombstones and fails closed instead of evicting one", () => {
  const h = stateHarness();
  for (let index = 0; index < 4096; index++) h.state.close(`retired-${index}`, "answered");
  h.observe(native("allowed"));
  h.expose();
  expect(h.registry.list()).toHaveLength(1);
  h.state.close("one-too-many", "answered");
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});
test("bounds retired UTF-8 key bytes and deduplicates replayed tombstones", () => {
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
test("overflow preserves native input hold then releases at a cleared composer", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe(native("oversized", 257));
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(captured("async-editor-first.txt"));
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(false);
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toEqual([]);
});

test("unmeasurable nested input fails closed without escaping the observer", () => {
  const h = stateHarness();
  h.observe(native("existing"));
  h.expose();
  const nested: unknown[] = [];
  nested.push(nested);
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "nested",
      delivery: "async",
      questions: [{ title: "Q", unknown: nested }],
    },
  });
  expect(disabledSnapshot(h)).toEqual([0, [], []]);
});

test("invalid metadata has no candidate cost and does not disable later questions", () => {
  const h = stateHarness();
  const call = { type: "function_call", name: "request_user_input_async" };
  h.observe({ payload: call });
  h.observe({ payload: { ...call, arguments: '{"questions":[{"title":"Q"}]}' } });
  h.observe(native("valid"));
  h.expose();
  expect(h.registry.list()).toHaveLength(1);
});
