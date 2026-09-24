/** Cancellation retains predecessor ownership through admission handoff (PRD §5.9). */
import { expect, test } from "vitest";
import { loopBoundaryTail, reserveLoopSubmission } from "../../src/core/simple/loop-boundary.ts";
import { activity, FakeTurnSession } from "./simple-turn-fakes.ts";

test.each([
  "waiting",
  "ready",
])("C-LOOP-08 cancelled %s successor does not strand its reservation", async (phase) => {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  const first = reserveLoopSubmission(session, session, {
    closing: closing.signal,
    admission: new AbortController().signal,
  });
  await first.ready;
  await first.submit(() => Promise.resolve());
  const previous = loopBoundaryTail(session);
  const abort = new AbortController();
  const second = reserveLoopSubmission(session, session, {
    closing: closing.signal,
    admission: abort.signal,
  });
  void second.ready.catch(() => undefined);
  const boundary = loopBoundaryTail(session);
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
    expect(loopBoundaryTail(session)).toBe(boundary);
    session.emit("status", { status: "stopped" });
  }
  await previous;
  await boundary;
  expect(complete).toBe(true);
  await expect(second.submit(() => Promise.reject(new Error("must not write")))).rejects.toThrow(
    "cancelled",
  );
  expect(session.listenerCount()).toBe(0);
  expect(loopBoundaryTail(session)).toBeUndefined();
});

test("C-LOOP-08 already closed admission never installs an observer", async () => {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  closing.abort();
  const ticket = reserveLoopSubmission(session, session, {
    closing: closing.signal,
    admission: new AbortController().signal,
  });
  const boundary = loopBoundaryTail(session);
  await expect(ticket.ready).rejects.toMatchObject({ code: "session_not_running" });
  await expect(boundary).resolves.toBeUndefined();
  expect(session.listenerCount()).toBe(0);
});

test("C-API-48 completed observation still waits for the physical loop write", async () => {
  const session = new FakeTurnSession();
  const writing = Promise.withResolvers<void>();
  const ticket = reserveLoopSubmission(session, session, {
    closing: new AbortController().signal,
    admission: new AbortController().signal,
  });
  await ticket.ready;
  const submission = ticket.submit(() => writing.promise);
  await Promise.resolve();
  expect(session.listenerCount()).toBe(3);
  const boundary = loopBoundaryTail(session);
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
  expect(loopBoundaryTail(session)).toBeUndefined();
});

test("C-API-50 submit waits for predecessor drain without a caller awaiting ready", async () => {
  const session = new FakeTurnSession();
  const owner = {};
  const signals = {
    closing: new AbortController().signal,
    admission: new AbortController().signal,
  };
  const writes: string[] = [];
  const first = reserveLoopSubmission(owner, session, signals);
  await first.submit(() => {
    writes.push("first");
    return Promise.resolve();
  });
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "FIRST" });
  session.emit("status", { status: "ready" });
  const second = reserveLoopSubmission(owner, session, signals);
  const submission = second.submit(() => {
    writes.push("second");
    return Promise.resolve();
  });
  const tail = loopBoundaryTail(owner);
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toEqual(["first"]);
  expect(session.listenerCount()).toBe(3);
  session.emit("activity", activity({ text: "FIRST" }));
  await submission;
  expect(writes).toEqual(["first", "second"]);
  expect(loopBoundaryTail(owner)).toBe(tail);
  expect(session.listenerCount()).toBe(3);
  session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "SECOND" });
  session.emit("status", { status: "ready" });
  session.emit("activity", activity({ text: "SECOND" }));
  await tail;
  expect(session.listenerCount()).toBe(0);
  expect(loopBoundaryTail(owner)).toBeUndefined();
});
