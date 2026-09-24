/** Active loop completion belongs to its own observer (PRD §5.8/§5.9, C-API-48). */
import { expect, test } from "vitest";
import { activeLoopBoundary, reserveLoopSubmission } from "../../src/core/simple/loop-boundary.ts";
import type { BoundarySession } from "../../src/core/simple/observe-boundary.ts";
import { activity, FakeTurnSession } from "./simple-turn-fakes.ts";

async function observeLoopSubmission(
  owner: object,
  session: BoundarySession,
  closing: AbortSignal,
  submit: () => Promise<void>,
) {
  const ticket = reserveLoopSubmission(owner, session, closing, new AbortController().signal);
  await ticket.ready;
  return ticket.run(submit);
}

test("C-API-48 an older loop cannot clear a newer loop's boundary", async () => {
  const owner = {};
  const first = new FakeTurnSession();
  const second = new FakeTurnSession();
  const closing = new AbortController();
  await observeLoopSubmission(owner, first, closing.signal, () => Promise.resolve());
  const prior = activeLoopBoundary(owner);
  const submitted = observeLoopSubmission(owner, second, closing.signal, () => Promise.resolve());
  const current = activeLoopBoundary(owner);
  expect(second.listenerCount()).toBe(0);
  first.emit("status", { status: "stopped" });
  await prior;
  await submitted;
  expect(activeLoopBoundary(owner)).toBe(current);
  second.emit("status", { status: "stopped" });
  await current;
  expect(activeLoopBoundary(owner)).toBeUndefined();
});

test("C-API-48 a second loop waits for the first observer's trailing boundary", async () => {
  const session = new FakeTurnSession();
  const owner = {};
  const closing = new AbortController();
  await observeLoopSubmission(owner, session, closing.signal, () => Promise.resolve());
  const first = activeLoopBoundary(owner);
  const writes: string[] = [];
  const second = observeLoopSubmission(owner, session, closing.signal, () => {
    writes.push("second");
    return Promise.resolve();
  });
  const waiting = activeLoopBoundary(owner);
  await Promise.resolve();
  await Promise.resolve();
  expect(waiting).not.toBe(first);
  expect(writes).toEqual([]);
  expect(session.listenerCount()).toBe(3);
  session.emit("status", { status: "stopped" });
  await first;
  await second;
  expect(writes).toEqual(["second"]);
  expect(session.listenerCount()).toBe(3);
  session.emit("status", { status: "stopped" });
  await waiting;
  expect(activeLoopBoundary(owner)).toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});

test("C-API-50 successive untagged loops wait for each trailing transcript", async () => {
  const session = new FakeTurnSession();
  const owner = {};
  const closing = new AbortController();
  const writes: string[] = [];
  await observeLoopSubmission(owner, session, closing.signal, () => {
    writes.push("first");
    return Promise.resolve();
  });
  const first = activeLoopBoundary(owner);
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "FIRST" });
  session.emit("status", { status: "ready" });
  const second = observeLoopSubmission(owner, session, closing.signal, () => {
    writes.push("second");
    return Promise.resolve();
  });
  const last = activeLoopBoundary(owner);
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toEqual(["first"]);
  expect(session.listenerCount()).toBe(3);
  session.emit("activity", activity({ text: "FIRST" }));
  await first;
  await second;
  expect(writes).toEqual(["first", "second"]);
  expect(session.listenerCount()).toBe(3);
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "SECOND" });
  session.emit("status", { status: "ready" });
  session.emit("activity", activity({ text: "SECOND" }));
  await last;
  expect(session.listenerCount()).toBe(0);
});

test("C-API-50 closing a predecessor rejects queued loops before their submission", async () => {
  const session = new FakeTurnSession();
  const owner = {};
  const closing = new AbortController();
  await observeLoopSubmission(owner, session, closing.signal, () => Promise.resolve());
  const first = activeLoopBoundary(owner);
  let submitted = false;
  const second = observeLoopSubmission(owner, session, closing.signal, () => {
    submitted = true;
    return Promise.resolve();
  });
  const waiting = activeLoopBoundary(owner);
  void second.catch(() => undefined);
  void waiting?.catch(() => undefined);
  expect(submitted).toBe(false);
  expect(session.listenerCount()).toBe(3);
  closing.abort();
  await expect(first).rejects.toMatchObject({ code: "session_not_running" });
  await expect(second).rejects.toMatchObject({ code: "session_not_running" });
  await expect(waiting).rejects.toMatchObject({ code: "session_not_running" });
  expect(submitted).toBe(false);
  expect(session.listenerCount()).toBe(0);
  expect(activeLoopBoundary(owner)).toBeUndefined();
});

test("C-API-48 a failed successor cannot clear a predecessor or later wait", async () => {
  const session = new FakeTurnSession();
  const owner = {};
  const closing = new AbortController();
  await observeLoopSubmission(owner, session, closing.signal, () => Promise.resolve());
  const first = activeLoopBoundary(owner);
  const failure = new Error("second failed");
  const second = observeLoopSubmission(owner, session, closing.signal, () =>
    Promise.reject(failure),
  );
  void second.catch(() => undefined);
  const third = observeLoopSubmission(owner, session, closing.signal, () => Promise.resolve());
  void third.catch(() => undefined);
  const waiting = activeLoopBoundary(owner);
  expect(session.listenerCount()).toBe(3);
  session.emit("status", { status: "stopped" });
  await first;
  await expect(second).rejects.toBe(failure);
  await Promise.resolve();
  expect(session.listenerCount()).toBe(3);
  session.emit("status", { status: "stopped" });
  await expect(third).resolves.toBeUndefined();
  await expect(waiting).resolves.toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});

test("C-API-48 closing rejects a caller's active-loop wait and removes the observer", async () => {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  await observeLoopSubmission(session, session, closing.signal, () => Promise.resolve());
  const waiting = activeLoopBoundary(session);
  closing.abort();
  await expect(waiting).rejects.toMatchObject({ code: "session_not_running" });
  expect(activeLoopBoundary(session)).toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});

test.each([
  "throw",
  "reject",
])("C-API-48 loop submission %s discards observation and releases callers", async (failure) => {
  const session = new FakeTurnSession();
  const error = new Error("cancelled or failed submission");
  let boundary: Promise<void> | undefined;
  const submission = observeLoopSubmission(session, session, new AbortController().signal, () => {
    boundary = activeLoopBoundary(session);
    if (failure === "throw") throw error;
    return Promise.reject(error);
  });
  await expect(submission).rejects.toBe(error);
  await expect(boundary).resolves.toBeUndefined();
  expect(activeLoopBoundary(session)).toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});
