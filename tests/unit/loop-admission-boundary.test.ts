/** Cancellation retains predecessor ownership through admission handoff (PRD §5.9). */
import { expect, test } from "vitest";
import { activeLoopBoundary, reserveLoopSubmission } from "../../src/core/simple/loop-boundary.ts";
import { FakeTurnSession } from "./simple-turn-fakes.ts";

test.each([
  "waiting",
  "ready",
])("C-LOOP-08 cancelled %s successor does not strand its reservation", async (phase) => {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  const first = reserveLoopSubmission(
    session,
    session,
    closing.signal,
    new AbortController().signal,
  );
  await first.ready;
  await first.run(() => Promise.resolve());
  const previous = activeLoopBoundary(session);
  const abort = new AbortController();
  const second = reserveLoopSubmission(session, session, closing.signal, abort.signal);
  void second.ready.catch(() => undefined);
  const boundary = activeLoopBoundary(session);
  let complete = false;
  void boundary!.then(() => {
    complete = true;
  });
  if (phase === "ready") {
    session.emit("status", { status: "stopped" });
    await second.ready;
  }
  abort.abort(new Error("cancelled"));
  if (phase === "waiting") {
    await expect(second.ready).rejects.toThrow("cancelled");
    expect(complete).toBe(false);
    expect(activeLoopBoundary(session)).toBe(boundary);
    session.emit("status", { status: "stopped" });
  }
  await previous;
  await boundary;
  expect(complete).toBe(true);
  await expect(second.run(() => Promise.reject(new Error("must not write")))).rejects.toThrow(
    "cancelled",
  );
  expect(session.listenerCount()).toBe(0);
  expect(activeLoopBoundary(session)).toBeUndefined();
});

test("C-LOOP-08 already closed admission never installs an observer", async () => {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  closing.abort();
  const ticket = reserveLoopSubmission(
    session,
    session,
    closing.signal,
    new AbortController().signal,
  );
  const boundary = activeLoopBoundary(session);
  await expect(ticket.ready).rejects.toMatchObject({ code: "session_not_running" });
  await expect(boundary).resolves.toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});

test("C-API-48 completed observation still waits for the physical loop write", async () => {
  const session = new FakeTurnSession();
  const writing = Promise.withResolvers<void>();
  const ticket = reserveLoopSubmission(
    session,
    session,
    new AbortController().signal,
    new AbortController().signal,
  );
  await ticket.ready;
  const submission = ticket.run(() => writing.promise);
  expect(session.listenerCount()).toBe(3);
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
