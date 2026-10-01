/** Internal owned completion controls; passive runtime behavior remains C-API-48/50. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createBoundaryObserver } from "../../src/core/simple/boundary-observer.ts";
import { activity } from "./simple-turn-fakes.ts";

const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function setup(accepted = true) {
  const closing = new AbortController();
  let isAccepted = accepted;
  const disposed = vi.fn();
  const observer = createBoundaryObserver(closing.signal, { accepted: () => isAccepted }, disposed);
  let completed = false;
  void observer.promise.then(
    () => {
      completed = true;
    },
    () => undefined,
  );
  cleanups.push(() => closing.abort());
  return {
    observer,
    closing,
    disposed,
    completed: () => completed,
    accept: () => {
      isAccepted = true;
    },
  };
}

test.each([
  "confirmed",
  "ordinary",
] as const)("owned %s pre-Stop idle requires fresh post-Stop idle", async (kind) => {
  const { observer, completed, disposed } = setup();
  if (kind === "confirmed") observer.confirmIdle({});
  else observer.observeStatus({ status: "ready" });
  observer.observeActivity(activity({ text: "tail" }));
  observer.confirmStop("tail", false);
  observer.observeStatus({ status: "ready" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  observer.confirmIdle({});
  await observer.promise;
  expect(completed()).toBe(true);
  expect(disposed).toHaveBeenCalledOnce();
});

test("owned Stop before ordinary readiness still waits for its trailing text", async () => {
  const { observer, completed } = setup();
  observer.confirmStop("tail", false);
  observer.observeStatus({ status: "ready" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  observer.observeActivity(activity({ text: "tail" }));
  await observer.promise;
  expect(completed()).toBe(true);
});

test("owned outcome may explicitly require fresh idle without an earlier ready event", async () => {
  const { observer, completed } = setup();
  observer.confirmStop("", true);
  observer.observeStatus({ status: "ready" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  observer.confirmIdle({});
  await vi.advanceTimersByTimeAsync(2_000);
  await observer.promise;
  expect(completed()).toBe(true);
});

test("explicit interrupted idle permits hookless completion after trailing content settles", async () => {
  const { observer, completed } = setup();
  observer.confirmIdle({ interrupted: true });
  await vi.advanceTimersByTimeAsync(1_500);
  observer.observeActivity(activity({ kind: "tool_result" }));
  await vi.advanceTimersByTimeAsync(1_500);
  expect(completed()).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await observer.promise;
  expect(completed()).toBe(true);
});

test("unaccepted lifecycle and content cannot complete or seed a later owned turn", async () => {
  const { observer, completed, accept } = setup(false);
  observer.observeStatus({ status: "running" });
  observer.observeActivity(activity({ text: "tail" }));
  observer.confirmIdle({ interrupted: true });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  accept();
  observer.confirmStop("tail", false);
  observer.observeStatus({ status: "ready" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  observer.observeActivity(activity({ text: "tail" }));
  await observer.promise;
});

test("owned observer closure rejects and disposes once without completion evidence", async () => {
  const { observer, closing, disposed } = setup();
  closing.abort();
  await expect(observer.promise).rejects.toMatchObject({ code: "session_not_running" });
  observer.discard();
  expect(disposed).toHaveBeenCalledOnce();
});

test.each([
  "Stop",
  "Notification",
] as const)("owned boundary ignores public %s before confirmed outcome", async (hook_event_name) => {
  const { observer, completed } = setup();
  observer.observeActivity(activity({ text: "tail" }));
  observer.observeHook({ hook_event_name, last_assistant_message: "tail" }, "ready");
  observer.observeStatus({ status: "ready" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(completed()).toBe(false);
  observer.confirmStop("tail", false);
  observer.confirmIdle({});
  await observer.promise;
  expect(completed()).toBe(true);
});
