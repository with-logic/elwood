/**
 * Serialized single-session slot behavior for the browser dev app.
 * Covers PRD §11 (C-APP-08): two concurrent session-mutating operations must
 * serialize so a replaced session is torn down, never leaked.
 */

import { describe, expect, test } from "vitest";
import type { SharedSession } from "../../src/app/agent-runtime.ts";
import { WebSessionSlot } from "../../src/app/web-session-slot.ts";

describe("web session slot", () => {
  test("C-APP-08 serializes runs so tasks never interleave", async () => {
    const slot = new WebSessionSlot();
    const order: string[] = [];
    const first = slot.run(async () => {
      order.push("first:start");
      await tick();
      order.push("first:end");
    });
    const second = slot.run(() => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("C-APP-08 replace tears down the outgoing session before storing the next", async () => {
    const slot = new WebSessionSlot();
    const first = fakeSession("s1");
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    expect(slot.session).toBe(first);
    await slot.run((s) => s.replace(second));
    expect(first.teardownCount).toBe(1);
    expect(slot.session).toBe(second);
  });

  test("C-APP-08 concurrent replaces leave exactly one live session, first torn down", async () => {
    const slot = new WebSessionSlot();
    const first = fakeSession("s1");
    const second = fakeSession("s2");
    // Both "start" tasks race; the second must not overwrite the first's slot
    // without tearing it down first.
    const a = slot.run((s) => s.replace(first));
    const b = slot.run((s) => s.replace(second));
    await Promise.all([a, b]);
    expect(slot.session).toBe(second);
    expect(first.teardownCount).toBe(1);
    expect(second.teardownCount).toBe(0);
  });

  test("C-APP-08 a failed teardown of the replaced session does not block replacement", async () => {
    const slot = new WebSessionSlot();
    const first = fakeSession("s1", { teardownThrows: true });
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    await slot.run((s) => s.replace(second));
    expect(slot.session).toBe(second);
  });

  test("C-APP-08 replacing the slot with the same session is a no-op teardown", async () => {
    const slot = new WebSessionSlot();
    const only = fakeSession("s1");
    await slot.run((s) => s.replace(only));
    await slot.run((s) => s.replace(only));
    expect(only.teardownCount).toBe(0);
  });

  test("C-APP-08 require throws when no session is running, returns it otherwise", async () => {
    const slot = new WebSessionSlot();
    await expect(slot.run(async (s) => s.require())).rejects.toThrow(
      "No Elwood session is running.",
    );
    const session = fakeSession("s1");
    await slot.run((s) => s.replace(session));
    await expect(slot.run(async (s) => s.require())).resolves.toBe(session);
  });

  test("C-APP-08 clearIf only clears when the active session matches", async () => {
    const slot = new WebSessionSlot();
    const first = fakeSession("s1");
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    slot.clearIf(second);
    expect(slot.session).toBe(first);
    slot.clearIf(first);
    expect(slot.session).toBeNull();
  });

  test("C-APP-08 take detaches the active session without tearing it down", async () => {
    const slot = new WebSessionSlot();
    const session = fakeSession("s1");
    await slot.run((s) => s.replace(session));
    expect(slot.take()).toBe(session);
    expect(slot.take()).toBeNull();
    expect(session.teardownCount).toBe(0);
  });

  test("C-APP-08 a rejected run keeps the queue alive for later runs", async () => {
    const slot = new WebSessionSlot();
    const failing = slot.run(() => Promise.reject(new Error("boom")));
    await expect(failing).rejects.toThrow("boom");
    await expect(slot.run(async () => 7)).resolves.toBe(7);
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

type FakeOptions = { readonly teardownThrows?: boolean };

type FakeSession = SharedSession & { teardownCount: number };

function fakeSession(id: string, options: FakeOptions = {}): FakeSession {
  const session = {
    elwoodSessionId: id,
    cwd: "/w",
    status: "running",
    warnings: [],
    terminal: {} as never,
    teardownCount: 0,
    statusDecisions: () => [],
    on: () => () => {},
    sendPrompt: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    sendGuidance: () => Promise.resolve(),
    sendKeys: () => Promise.resolve(),
    resize: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    teardown: () => {
      session.teardownCount += 1;
      return options.teardownThrows
        ? Promise.reject(new Error("teardown failed"))
        : Promise.resolve();
    },
  } satisfies FakeSession;
  return session;
}
