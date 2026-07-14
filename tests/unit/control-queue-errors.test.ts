/**
 * Ordering and failure-path tests for the control-operation queue.
 * Covers PRD §5.3 and C-API-19.
 */

import { describe, expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue.ts";

describe("ControlQueue ordering and failures", () => {
  test("C-API-19 drains the next operation only after the prior submit resolves", async () => {
    // A command's submit resolves late (its delayed Enter); the queue must not
    // release the next operation until then, preserving FIFO terminal writes.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const queue = new ControlQueue(
      (input) => {
        order.push(`submit:${input}`);
        if (input === "/compact") {
          return new Promise<void>((resolve) => {
            releaseFirst = () => {
              order.push("enter:/compact");
              resolve();
            };
          });
        }
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const first = queue.send("/compact", "compact");
    const second = queue.send("/model", "list_models");
    // The second command has not been written yet: its predecessor's Enter
    // is still pending.
    expect(order).toEqual(["submit:/compact"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["submit:/compact", "enter:/compact", "submit:/model"]);
  });

  test("C-API-19 a message holds the next command until its submit resolves", async () => {
    // The message-mode submitter resolves only after its (delayed) Enter; a
    // command queued behind it must not write until then, preserving FIFO.
    const order: string[] = [];
    let releaseMessage: (() => void) | undefined;
    const queue = new ControlQueue(
      (input, mode) => {
        order.push(`${mode}:${input}`);
        if (mode === "pasted_input") {
          return new Promise<void>((resolve) => {
            releaseMessage = resolve;
          });
        }
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const message = queue.send("hello", "message");
    const command = queue.send("/model", "list_models");
    // Only the message has been written; the command waits for its submit.
    expect(order).toEqual(["pasted_input:hello"]);
    releaseMessage?.();
    await Promise.all([message, command]);
    expect(order).toEqual(["pasted_input:hello", "command:/model"]);
  });

  test("C-API-19 rejects queued and future operations after close", async () => {
    const queue = new ControlQueue(
      () => Promise.resolve(),
      () => new Error("session_not_running"),
      () => undefined,
    );
    const queued = queue.send("later", "message");
    queue.close();
    await expect(queued).rejects.toThrow("session_not_running");
    await expect(queue.send("future", "compact")).rejects.toThrow("session_not_running");
  });

  test("C-API-19 propagates synchronous submit failures", async () => {
    const queue = new ControlQueue(
      () => {
        throw new Error("raw failure");
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    await expect(queue.send("boom", "message")).rejects.toThrow("raw failure");
  });

  test("C-API-19 an async submit rejection rejects the op and keeps draining", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return input === "bad"
          ? Promise.reject(new Error("async submit failure"))
          : Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const bad = queue.send("bad", "message");
    const next = queue.send("next", "message");
    // The rejected submit rejects its own op (no unhandled rejection)...
    await expect(bad).rejects.toThrow("async submit failure");
    // ...and inFlight clears so the queue keeps draining the next op.
    queue.markReady();
    await next;
    expect(submitted).toEqual(["bad", "next"]);
  });

  test("C-API-19 close rejects the operation still dispatching in flight", async () => {
    // A command whose delayed Enter never resolves is in flight when close()
    // is called; it must reject immediately with the stopped error, and its
    // own late settle must not override that.
    let releaseLate: (() => void) | undefined;
    const queue = new ControlQueue(
      () =>
        new Promise<void>((resolve) => {
          releaseLate = resolve;
        }),
      () => new Error("session_not_running"),
      () => undefined,
    );
    queue.markReady();
    const inFlight = queue.send("/model", "list_models");
    queue.close();
    await expect(inFlight).rejects.toThrow("session_not_running");
    // The dispatched promise resolving afterwards is a no-op (already settled).
    releaseLate?.();
    await Promise.resolve();
  });

  test("C-API-19 ignores running and ready after close", async () => {
    const queue = new ControlQueue(
      () => Promise.resolve(),
      () => new Error("closed"),
      () => undefined,
    );
    queue.close();
    queue.suspendReadiness();
    queue.markReady();
    await expect(queue.send("ignored", "message")).rejects.toThrow("closed");
  });

  test("C-API-37 guidance does not bypass without an active-turn policy", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    queue.suspendReadiness();
    const held = queue.send("held", "guidance");
    expect(submitted).toEqual([]);
    queue.close();
    await expect(held).rejects.toThrow("closed");
  });

  test("C-API-31 the prior submission's abort signal fires before the next dispatches", async () => {
    // A submission's background recovery nudges are cancelled when the next
    // operation begins, so an older nudge can't fire an Enter into a later paste.
    const signals: AbortSignal[] = [];
    const queue = new ControlQueue(
      (_input, _mode, signal) => {
        signals.push(signal);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    // Picker commands don't consume readiness, so two dispatch back-to-back.
    await queue.send("/model", "list_models");
    expect(signals[0]?.aborted).toBe(false);
    await queue.send("/model", "set_model");
    // Dispatching the second submission aborts the first's background work.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
