/**
 * Serialized single-session slot behavior for the browser dev app.
 * Covers PRD §11 (C-APP-08): two concurrent session-mutating operations must
 * serialize so a replaced session is torn down (never leaked), and a discarded
 * session's teardown failure is reported rather than silently dropped.
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

  test("C-APP-08 replace installs the next session then tears down the outgoing one", async () => {
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

  test("C-APP-08 a failed teardown does not block replacement AND is reported", async () => {
    const reported: Array<{ id: string; error: unknown }> = [];
    const slot = new WebSessionSlot((id, error) => reported.push({ id, error }));
    const first = fakeSession("s1", { teardownThrows: true });
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    await slot.run((s) => s.replace(second));
    expect(slot.session).toBe(second); // the incoming session still took the slot
    // The discarded session's teardown failure was surfaced, not silently dropped.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.id).toBe("s1");
    expect(String(reported[0]?.error)).toContain("teardown failed");
  });

  test("C-APP-08 a THROWING teardown reporter does not reject replace or unwire the new session", async () => {
    // If the reporter throws (e.g. broadcast during a socket-close race), replace() must
    // still resolve with the new session installed (else wireSession never runs for it).
    const slot = new WebSessionSlot(() => {
      throw new Error("broadcast boom");
    });
    const first = fakeSession("s1", { teardownThrows: true });
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    await expect(slot.run((s) => s.replace(second))).resolves.toBeUndefined();
    expect(slot.session).toBe(second);
  });

  test("C-APP-08 a failed teardown with no reporter is still contained", async () => {
    const slot = new WebSessionSlot(); // no reporter wired
    const first = fakeSession("s1", { teardownThrows: true });
    const second = fakeSession("s2");
    await slot.run((s) => s.replace(first));
    await slot.run((s) => s.replace(second)); // must not reject despite the throw
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

  test("C-APP-08 closeAndTake refuses new work and returns the in-flight session", async () => {
    // Shutdown races an in-flight start: closeAndTake must wait for the start to install
    // its session, return THAT session, and refuse later runs (no resurrection).
    const slot = new WebSessionSlot();
    const session = fakeSession("s1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = slot.run(async (s) => {
      await gate; // a start mid-flight when shutdown begins
      await s.replace(session);
    });
    const closing = slot.closeAndTake(); // begins shutdown while the start is parked
    release();
    await starting;
    expect(await closing).toBe(session); // returned the just-installed session, not null
    expect(slot.session).toBeNull(); // detached, not left live
    // Post-close work is refused, so nothing can re-install a session after teardown.
    await expect(slot.run(async () => 1)).rejects.toThrow(/shutting down/);
  });

  test("C-APP-08 closeAndTake tolerates an in-flight task that REJECTED", async () => {
    // A rejected in-flight task must still let closeAndTake settle, not hang or throw.
    const slot = new WebSessionSlot();
    const failing = slot.run(() => Promise.reject(new Error("boom")));
    await expect(failing).rejects.toThrow("boom");
    expect(await slot.closeAndTake()).toBeNull();
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
