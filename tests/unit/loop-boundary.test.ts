/** Active loop completion belongs to its own observer (PRD §5.8/§5.9, C-API-48). */
import { expect, test } from "vitest";
import { activeLoopBoundary, observeLoopSubmission } from "../../src/core/simple/loop-boundary.ts";
import { FakeTurnSession } from "./simple-turn-fakes.ts";

test("C-API-48 an older loop cannot clear a newer loop's boundary", async () => {
  const owner = {};
  const first = new FakeTurnSession();
  const second = new FakeTurnSession();
  const closing = new AbortController();
  await observeLoopSubmission(owner, first, closing.signal, () => Promise.resolve());
  const prior = activeLoopBoundary(owner);
  await observeLoopSubmission(owner, second, closing.signal, () => Promise.resolve());
  const current = activeLoopBoundary(owner);
  first.emit("status", { status: "stopped" });
  await prior;
  expect(activeLoopBoundary(owner)).toBe(current);
  second.emit("status", { status: "stopped" });
  await current;
  expect(activeLoopBoundary(owner)).toBeUndefined();
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

test("C-API-48 completed observation still waits for the physical loop write", async () => {
  const session = new FakeTurnSession();
  const writing = Promise.withResolvers<void>();
  const submission = observeLoopSubmission(
    session,
    session,
    new AbortController().signal,
    () => writing.promise,
  );
  const boundary = activeLoopBoundary(session);
  let released = false;
  void boundary!.then(() => {
    released = true;
  });
  session.emit("status", { status: "stopped" });
  await Promise.resolve();
  await Promise.resolve();
  expect(released).toBe(false);
  writing.resolve();
  await submission;
  await boundary;
  expect(released).toBe(true);
  expect(activeLoopBoundary(session)).toBeUndefined();
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
