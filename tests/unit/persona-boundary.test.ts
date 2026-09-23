/** Startup persona barriers preserve readiness and shutdown semantics (PRD §5.8, C-API-21/48). */
import { expect, test, vi } from "vitest";
import { personaBoundary, queuePersonaMessage } from "../../src/core/persona.ts";
import { FakeUnderlying } from "./simple-fakes.ts";

test("C-API-21 initial ready cannot finish a persona before its submission", async () => {
  const session = new FakeUnderlying();
  const submitted = Promise.withResolvers<void>();
  vi.spyOn(session, "sendMessage").mockReturnValue(submitted.promise);
  queuePersonaMessage(session, "persona");
  let finished = false;
  const boundary = personaBoundary(session)!.then(() => {
    finished = true;
  });
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  await Promise.resolve();
  expect(finished).toBe(false);
  session.status = "running";
  submitted.resolve();
  await Promise.resolve();
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
  await Promise.resolve();
  expect(finished).toBe(false);
  session.status = "ready";
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  await boundary;
  expect(personaBoundary(session)).toBeUndefined();
});

test.each([
  "ready",
  "stopped",
] as const)("C-API-21 already %s persona needs no status listener", async (status) => {
  const session = new FakeUnderlying();
  session.status = status;
  vi.spyOn(session, "sendMessage").mockResolvedValue();
  const on = vi.spyOn(session, "on");
  queuePersonaMessage(session, "persona");
  await personaBoundary(session);
  expect(on).not.toHaveBeenCalled();
  expect(personaBoundary(session)).toBeUndefined();
});

test("C-API-21 shutdown releases a running persona barrier", async () => {
  const session = new FakeUnderlying();
  session.status = "running";
  vi.spyOn(session, "sendMessage").mockResolvedValue();
  queuePersonaMessage(session, "persona");
  const boundary = personaBoundary(session);
  await Promise.resolve();
  session.status = "stopped";
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await boundary;
  expect(personaBoundary(session)).toBeUndefined();
});

test("C-API-21 a rejected persona submission is discarded without rejecting its waiter", async () => {
  const session = new FakeUnderlying();
  vi.spyOn(session, "sendMessage").mockRejectedValue(new Error("write failed"));
  queuePersonaMessage(session, "persona");
  await expect(personaBoundary(session)).resolves.toBeUndefined();
  expect(personaBoundary(session)).toBeUndefined();
});

test("C-API-21 no persona creates no submission or boundary", () => {
  const session = new FakeUnderlying();
  const send = vi.spyOn(session, "sendMessage");
  expect(queuePersonaMessage(session, undefined)).toBe(session);
  expect(send).not.toHaveBeenCalled();
  expect(personaBoundary(session)).toBeUndefined();
});
