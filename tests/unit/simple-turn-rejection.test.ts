/**
 * A turn the agent rejects fails as `turn_failed` while the serializer boundary still waits for
 * the agent's real `ready` and drain, and an empty `Stop` stays a successful empty reply
 * (PRD §5.8, C-API-59). Runs under fake timers so the windows are explicit.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeBoundarySignal } from "../../src/claude/hooks/stop-failure.ts";
import { activity, collect, drive, runTurnFake } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const rejection = { hook_event_name: "StopFailure", error: "model_not_found" } as const;

test("C-API-59 a StopFailure before ready fails the turn; the boundary waits for ready and drain", async () => {
  const s = drive((s) => {
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s.emit("status", { status: "running" });
    s.emit("activity", activity({ text: "partial" }));
    s.emit("hook", rejection);
  });
  const turn = runTurnFake(s, { readBoundarySignal: claudeBoundarySignal, drainMs: 100 });
  const events = collect(turn.events);
  events.catch(() => undefined);
  let released = false;
  void turn.boundary.then(() => (released = true));
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(events).rejects.toMatchObject({
    code: "turn_failed",
    details: { info: "model_not_found" },
  });
  expect(released).toBe(false); // the agent has not reached its real boundary yet
  s.emit("status", { status: "ready" });
  await vi.advanceTimersByTimeAsync(99);
  expect(released).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(released).toBe(true);
  expect(s.submissions).toBe(1); // never replayed
  expect(s.listenerCount()).toBe(0);
});

test("C-API-59 a StopFailure after ready yields collected text, then rejects", async () => {
  const s = drive((s) => {
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s.emit("status", { status: "running" });
    s.emit("status", { status: "ready" });
    s.emit("activity", activity({ text: "There's an issue with the selected model." }));
    s.emit("hook", rejection);
  });
  const turn = runTurnFake(s, { readBoundarySignal: claudeBoundarySignal, drainMs: 100 });
  const seen: unknown[] = [];
  const consumed = (async () => {
    for await (const event of turn.events) seen.push(event);
  })();
  consumed.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(consumed).rejects.toMatchObject({ code: "turn_failed" });
  expect(seen).toEqual([{ type: "text", text: "There's an issue with the selected model." }]);
  await turn.boundary; // ready was already seen, so only the drain remains
  expect(s.submissions).toBe(1);
});

test("C-API-59 an empty Stop with the Claude reader is still a successful empty reply", async () => {
  const s = drive((s) => {
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s.emit("status", { status: "running" });
    s.emit("hook", { hook_event_name: "Stop", last_assistant_message: null });
    s.emit("status", { status: "ready" });
  });
  const turn = runTurnFake(s, { readBoundarySignal: claudeBoundarySignal });
  const events = collect(turn.events);
  await vi.runAllTimersAsync();
  expect(await events).toEqual([]);
});
