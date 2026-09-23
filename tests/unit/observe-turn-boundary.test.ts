/** Passive internal turns use the ergonomic completion/drain contract (PRD §5.8, C-API-48/50). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { observeTurnBoundary } from "../../src/core/simple/observe-boundary.ts";
import { activity, FakeTurnSession } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(closing = new AbortController()) {
  const session = new FakeTurnSession();
  const observer = observeTurnBoundary(session, closing.signal);
  let settled = false;
  void observer.promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { session, observer, settled: () => settled };
}

test("C-API-48 initial ready is ignored, then a delayed Stop oracle gates transcript completion", async () => {
  const { session, observer, settled } = setup();
  session.emit("status", { status: "ready" });
  session.emit("status", { status: "starting" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(settled()).toBe(false);
  session.status = "running";
  session.emit("status", { status: "running" });
  session.emit("status", { status: "ready" });
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "tail" });
  session.emit("hook", { hook_event_name: "Notification" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(settled()).toBe(false);
  session.emit("activity", activity({ text: "tail" }));
  await observer.promise;
  expect(session.listenerCount()).toBe(0);
  expect(session.submissions).toBe(0);
});

test("C-API-48 tool content after ready re-arms the quiet fallback", async () => {
  const { session, observer, settled } = setup();
  session.emit("activity", activity({ kind: "tool_call" }));
  session.emit("status", { status: "ready" });
  await vi.advanceTimersByTimeAsync(1_500);
  session.emit("activity", activity({ kind: "tool_result" }));
  await vi.advanceTimersByTimeAsync(1_500);
  expect(settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await observer.promise;
  expect(session.listenerCount()).toBe(0);
});

test("C-API-50 catch-up failure still drains trailing activity before releasing the slot", async () => {
  const { session, observer, settled } = setup();
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "missing" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  session.emit("activity", activity({ kind: "status" }));
  await vi.advanceTimersByTimeAsync(500);
  expect(settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  await observer.promise;
  expect(session.listenerCount()).toBe(0);
});

test("C-API-50 a backlog failure while running waits for ready and its trailing drain", async () => {
  const { session, observer, settled } = setup();
  session.status = "running";
  for (let i = 0; i <= 100_000; i++) session.emit("activity", activity({ kind: "tool_call" }));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(settled()).toBe(false);
  session.emit("status", { status: "ready" });
  await vi.advanceTimersByTimeAsync(750);
  await observer.promise;
  expect(session.listenerCount()).toBe(0);
});

test.each([
  false,
  true,
])("C-API-50 closing cancels an observer (already aborted: %s)", async (aborted) => {
  const closing = new AbortController();
  if (aborted) closing.abort();
  const { session, observer } = setup(closing);
  closing.abort();
  await expect(observer.promise).rejects.toMatchObject({ code: "session_not_running" });
  expect(session.listenerCount()).toBe(0);
});

test.each([
  "terminal",
  "discard",
])("C-API-50 %s releases observer listeners immediately", async (reason) => {
  const { session, observer } = setup();
  if (reason === "terminal") session.emit("status", { status: "stopped" });
  else observer.discard();
  await observer.promise;
  expect(session.listenerCount()).toBe(0);
});
