/** Native question reservations survive stale and incomplete frames (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, emptyComposerFrame, frame, records } from "./helpers.ts";

test("a newly observed supported question reserves the stale empty composer", () => {
  const h = harness();
  h.adapter.render(emptyComposerFrame());
  expect(h.observe(records("async-records.json")[0])).toBe(true);
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  expect(h.registry.list()).toEqual([]);
  h.observe(records("async-records.json")[1]);
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(captured("async-badge.txt"));
  expect(h.registry.list()).toHaveLength(2);
  h.adapter.render(emptyComposerFrame());
  expect(h.registry.list()).toEqual([]);
  expect(h.adapter.blocksInput()).toBe(false);
});
test("unsupported native metadata holds until a native lifecycle boundary", () => {
  const h = harness();
  h.adapter.render(emptyComposerFrame());
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "secret",
      delivery: "async",
      questions: [{ title: "Q", isSecret: true }],
    },
  });
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(frame("• Queued follow-up inputs\npartial"));
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(captured("async-editor-first.txt"));
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.adapter.blocksInput()).toBe(false);
  expect(h.events).toEqual([]);
});
test("a hidden composer cursor cannot withdraw native requests", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const requests = h.registry.list();
  h.adapter.render({ ...emptyComposerFrame(), cursorVisible: false });
  expect(h.registry.list()).toEqual(requests);
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(emptyComposerFrame());
  expect(h.registry.list()).toEqual([]);
});
test("seeing an older question cannot release a later unpublished candidate", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "later",
      delivery: "async",
      questions: [{ title: "New" }],
    },
  });
  h.adapter.render(emptyComposerFrame());
  expect(h.registry.list()).toEqual([]);
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.adapter.blocksInput()).toBe(false);
});
test("unrecognized partial question UI retains a hold across blank redraws", () => {
  const h = harness();
  h.adapter.render(frame("Question 1/2 (2 unanswered)\npartial native frame"));
  h.adapter.render(frame(""));
  expect(h.adapter.blocksInput()).toBe(true);
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(false);
});
test("unchanged pre-call chrome cannot release a newly unsupported question", () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  const old = captured("async-badge.txt");
  h.adapter.render(old);
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "new-secret",
      delivery: "async",
      questions: [{ title: "New", isSecret: true }],
    },
  });
  h.adapter.render(old); // activity refresh reads the previous completed panel
  h.adapter.render(emptyComposerFrame());
  expect(h.adapter.blocksInput()).toBe(true);
  h.observe({ payload: { type: "turn_complete" } });
  expect(h.adapter.blocksInput()).toBe(false);
});
