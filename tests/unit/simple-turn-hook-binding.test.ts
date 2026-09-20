/** Accepted hook identity fences replayed content before a turn produces text (C-API-48). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activity, drive, runFakeTimed } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  "UserPromptSubmit",
  "Stop",
])("C-API-48 an accepted %s binds before stale content arrives", async (hook_event_name) => {
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    s.emit("hook", { hook_event_name, prompt: "go", turn_id: "current" });
    s.emit("activity", activity({ text: "STALE", turnId: "previous" }));
    s.emit("activity", activity({ kind: "reasoning", text: "thinking" }));
    s.emit("activity", activity({ text: "MINE", turnId: "current" }));
    s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
    s.emit("status", { status: "ready" });
  });
  expect(await runFakeTimed(session)).toEqual([
    { type: "thinking", text: "thinking" },
    { type: "text", text: "MINE" },
  ]);
});

test.each([
  undefined,
  "",
  42,
  null,
])("C-API-48 an invalid hook ID (%s) preserves content binding", async (turn_id) => {
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go", turn_id });
    s.emit("activity", activity({ text: "MINE", turnId: "current" }));
    s.emit("activity", activity({ text: "STALE", turnId: "previous" }));
    s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
    s.emit("status", { status: "ready" });
  });
  expect(await runFakeTimed(session)).toEqual([{ type: "text", text: "MINE" }]);
});

test("C-API-48 unrelated hooks cannot bind and later accepted hooks cannot rebind", async () => {
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    s.emit("hook", { hook_event_name: "Notification", turn_id: "previous" });
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "other", turn_id: "previous" });
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go", turn_id: "current" });
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go", turn_id: "previous" });
    s.emit("activity", activity({ text: "STALE", turnId: "previous" }));
    s.emit("activity", activity({ text: "MINE", turnId: "current" }));
    s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
    s.emit("status", { status: "ready" });
  });
  expect(await runFakeTimed(session)).toEqual([{ type: "text", text: "MINE" }]);
});

test("C-API-48 a late accepted hook does not replace the first content binding", async () => {
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    s.emit("activity", activity({ text: "MINE", turnId: "current" }));
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go", turn_id: "previous" });
    s.emit("activity", activity({ text: "STALE", turnId: "previous" }));
    s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
    s.emit("status", { status: "ready" });
  });
  expect(await runFakeTimed(session)).toEqual([{ type: "text", text: "MINE" }]);
});
