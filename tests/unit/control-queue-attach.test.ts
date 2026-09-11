/**
 * Coverage for the control queue's image-attach path (PRD §5.3, C-API-44): an
 * attach runs before the text write, and an attach FAILURE fails the op without
 * writing text and without wedging the queue (the lifecycle transition is
 * deferred until the attach succeeds, so readiness is never consumed on failure).
 */

import { describe, expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { PendingOperation } from "../../src/core/control-queue/types.ts";

describe("ControlQueue image attach (C-API-44)", () => {
  test("C-API-44 the run/attach XOR forbids an op carrying BOTH at compile time", () => {
    const task = () => Promise.resolve();
    const attachOnly: PendingOperation = {
      input: "x",
      kind: "message",
      mayBypassReadiness: false,
      origin: { kind: "caller" },
      attach: task,
    };
    // @ts-expect-error — an op cannot carry BOTH run and attach; dispatch would else
    // prefer run and silently drop the attachment (the XOR closes that hole).
    const both: PendingOperation = {
      input: "",
      kind: "message",
      mayBypassReadiness: false,
      origin: { kind: "caller" },
      run: task,
      attach: task,
    };
    expect(attachOnly.attach).toBe(task);
    void both; // the `@ts-expect-error` above is the assertion; no runtime check applies
  });

  test("C-API-44 runs a send's attach task before its text write", async () => {
    const events: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        events.push(`text:${input}`);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    await queue.send("hello", "message", () => {
      events.push("attach");
      return Promise.resolve();
    });
    expect(events).toEqual(["attach", "text:hello"]);
  });

  test("C-API-44 a throwing attach fails the op, writes no text, and never wedges the queue", async () => {
    const writes: string[] = [];
    let turnsStarted = 0;
    const queue = new ControlQueue(
      (input) => {
        writes.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => turnsStarted++,
    );
    queue.markReady();
    await expect(
      queue.send("hello", "message", () => Promise.reject(new Error("attach boom"))),
    ).rejects.toThrow(/attach boom/);
    expect(writes).toEqual([]);
    // The deferred lifecycle means the failed attach neither started a turn nor
    // consumed readiness: a following plain message still dispatches immediately.
    expect(turnsStarted).toBe(0);
    await queue.send("next", "message");
    expect(writes).toEqual(["next"]);
    expect(turnsStarted).toBe(1);
  });

  test("C-API-44 a throwing turn-start listener after a successful attach still sends the text", async () => {
    const writes: string[] = [];
    let throwOnce = true;
    const queue = new ControlQueue(
      (input) => {
        writes.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("turn-start boom"); // throws AFTER images are staged
        }
      },
    );
    queue.markReady();
    // The attach ran (images staged); a throwing turn-start listener is isolated so
    // the text still submits and the op resolves, and the next op still drains. A
    // throwing telemetry listener cannot wedge the session: the lifecycle commit and
    // queue transition are in-memory and never gated on a listener succeeding.
    await queue.send("hello", "message", () => Promise.resolve());
    expect(writes).toEqual(["hello"]);
    queue.markReady(); // a real Stop hook re-marks ready between turns
    await queue.send("next", "message");
    expect(writes).toEqual(["hello", "next"]);
  });

  test("C-API-44 a close DURING attach rejects without writing text", async () => {
    const writes: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        writes.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    // The attach observes the signal abort that close() fires, then returns; the
    // queue must reject (not write text) because the signal is now aborted.
    const failed = queue.send("hello", "message", (signal) => {
      queue.close();
      return signal.aborted ? Promise.resolve() : Promise.reject(new Error("expected abort"));
    });
    await expect(failed).rejects.toThrow(/closed/);
    expect(writes).toEqual([]);
  });
});
