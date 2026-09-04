/**
 * Attributed, cancellable control-queue delivery at the first-Enter boundary.
 * Implements PRD §5.9 and C-LOOP-05/06/08/09/17/20.
 */

import { describe, expect, test } from "vitest";
import { type ControlDispatchNotification, ControlQueue } from "../../src/core/control-queue.ts";

const loopOrigin = { kind: "loop", loopId: "loop-1" } as const;

describe("ControlQueue cancellation and attribution", () => {
  test("C-LOOP-17 cancels a readiness-waiting loop message without dispatch", async () => {
    const submitted: string[] = [];
    const notifications: ControlDispatchNotification[] = [];
    const cancel = new AbortController();
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
      undefined,
      (notification) => notifications.push(notification),
    );
    const pending = queue.send("scheduled", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
      origin: loopOrigin,
    });
    cancel.abort();
    await expect(pending).rejects.toThrow("cancelled");
    queue.markReady();
    expect(submitted).toEqual([]);
    expect(notifications).toEqual([
      { kind: "cancelled", operationKind: "message", origin: loopOrigin },
    ]);
  });

  test("C-LOOP-17 cancels an in-flight loop message before commit", async () => {
    const notifications: ControlDispatchNotification[] = [];
    const turns: string[] = [];
    const cancel = new AbortController();
    const queue = new ControlQueue(
      (_input, _mode, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      () => new Error("closed"),
      (origin) => turns.push(origin.kind),
      undefined,
      (notification) => notifications.push(notification),
    );
    queue.markReady();
    const pending = queue.send("scheduled", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
      origin: loopOrigin,
    });
    expect(turns).toEqual([]);
    cancel.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(turns).toEqual([]);
    expect(notifications).toEqual([
      { kind: "cancelled", operationKind: "message", origin: loopOrigin },
    ]);
  });

  test("C-LOOP-09 commits loop turn evidence only after Enter settles", async () => {
    const events: string[] = [];
    let release!: () => void;
    const queue = new ControlQueue(
      () => new Promise<void>((resolve) => (release = resolve)),
      () => new Error("closed"),
      (origin) => events.push(`turn:${origin.kind}`),
      undefined,
      (notification) => events.push(`notify:${notification.kind}`),
    );
    queue.markReady();
    const pending = queue.send("scheduled", "message", undefined, { origin: loopOrigin });
    expect(events).toEqual([]);
    release();
    await pending;
    expect(events).toEqual(["turn:loop", "notify:committed"]);
  });

  test("C-LOOP-06 caller turn timing stays eager and post-commit cancel is a no-op", async () => {
    const events: string[] = [];
    const cancel = new AbortController();
    let release!: () => void;
    const queue = new ControlQueue(
      () => new Promise<void>((resolve) => (release = resolve)),
      () => new Error("closed"),
      (origin) => events.push(`turn:${origin.kind}`),
      undefined,
      (notification) => events.push(`notify:${notification.kind}`),
    );
    queue.markReady();
    const pending = queue.send("caller", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("too late") },
    });
    expect(events).toEqual(["turn:caller"]);
    release();
    await pending;
    cancel.abort();
    expect(events).toEqual(["turn:caller", "notify:committed"]);
  });

  test("a cancelled non-bypassing op does not corrupt guidance bypass accounting", async () => {
    const submitted: string[] = [];
    const cancel = new AbortController();
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
      () => true,
    );
    queue.markReady();
    queue.suspendReadiness();
    const cancelled = queue.send("drop", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
    });
    cancel.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    const held = queue.send("held", "message");
    await queue.send("urgent", "guidance");
    expect(submitted).toEqual(["urgent"]);
    queue.close();
    await expect(held).rejects.toThrow("closed");
  });

  test("failure notification carries origin and throwing observers stay contained", async () => {
    const notifications: ControlDispatchNotification[] = [];
    const queue = new ControlQueue(
      (input) => (input === "bad" ? Promise.reject(new Error("write failed")) : Promise.resolve()),
      () => new Error("closed"),
      () => undefined,
      undefined,
      (notification) => {
        notifications.push(notification);
        throw new Error("observer failed");
      },
    );
    queue.markReady();
    await expect(queue.send("bad", "message", undefined, { origin: loopOrigin })).rejects.toThrow(
      "write failed",
    );
    await expect(queue.send("next", "message")).resolves.toBeUndefined();
    expect(notifications.map(({ kind, origin }) => [kind, origin.kind])).toEqual([
      ["failed", "loop"],
      ["committed", "caller"],
    ]);
  });
});
