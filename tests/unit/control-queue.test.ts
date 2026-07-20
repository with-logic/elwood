/**
 * Unit tests for the typed control-operation queue.
 * Covers PRD §5.3 and C-API-19.
 */

import { describe, expect, test } from "vitest";
import { ControlQueue, type ControlSubmitMode } from "../../src/core/control-queue.ts";

describe("ControlQueue", () => {
  test("C-API-19 submits immediately when ready and marks the turn started", async () => {
    const submitted: string[] = [];
    let turnsStarted = 0;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => turnsStarted++,
    );
    queue.markReady();
    await queue.send("one", "message");
    expect(submitted).toEqual(["one"]);
    expect(turnsStarted).toBe(1);
    const queued = queue.send("two", "message");
    expect(submitted).toEqual(["one"]);
    queue.markReady();
    await queued;
    expect(submitted).toEqual(["one", "two"]);
  });

  test("C-API-19 command operations keep readiness and start no turn", async () => {
    const submitted: Array<{ input: string; mode: ControlSubmitMode }> = [];
    let turnsStarted = 0;
    const queue = new ControlQueue(
      (input, mode) => {
        submitted.push({ input, mode });
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => turnsStarted++,
    );
    queue.markReady();
    await queue.send("/compact", "compact");
    await queue.send("/model", "list_models");
    await queue.send("/model", "set_model");
    // Readiness was not consumed: a message still submits without a new mark.
    await queue.send("after", "message");
    expect(submitted.map((entry) => entry.mode)).toEqual([
      "command",
      "command",
      "command",
      "pasted_input",
    ]);
    expect(turnsStarted).toBe(1);
  });

  test("C-API-19 picker commands dispatch while not ready; messages/compact wait", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    // Never marked ready: /model picker automation still dispatches (it can run
    // mid-turn, e.g. while an MCP boot spinner is up); a message waits.
    await queue.send("/model", "list_models");
    expect(submitted).toEqual(["/model"]);
    const queuedMessage = queue.send("hello", "message");
    expect(submitted).toEqual(["/model"]);
    // C-API-35: a picker command queued behind a readiness-waiting message
    // OVERTAKES it and dispatches immediately rather than stalling behind the
    // in-flight turn — it is an immediate operation, not readiness-waiting.
    const queuedCommand = queue.send("/model2", "set_model");
    await queuedCommand;
    expect(submitted).toEqual(["/model", "/model2"]);
    queue.markReady();
    await queuedMessage;
    expect(submitted).toEqual(["/model", "/model2", "hello"]);
  });

  test("C-API-22 compact waits for readiness like a message", async () => {
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    const compacting = queue.send("/compact", "compact");
    expect(submitted).toEqual([]); // not ready → held, per C-API-22
    queue.markReady();
    await compacting;
    expect(submitted).toEqual(["/compact"]);
  });

  test("C-API-37 guidance overtakes a waiting message but submissions stay serialized", async () => {
    const submitted: string[] = [];
    let release = (): void => {};
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      () => new Error("closed"),
      () => undefined,
      () => true,
    );
    queue.markReady();
    queue.suspendReadiness();
    const waiting = queue.send("later", "message");
    const first = queue.send("urgent-1", "guidance");
    const second = queue.send("urgent-2", "guidance");
    expect(submitted).toEqual(["urgent-1"]);
    release();
    await first;
    expect(submitted).toEqual(["urgent-1", "urgent-2"]);
    release();
    await second;
    queue.markReady();
    expect(submitted).toEqual(["urgent-1", "urgent-2", "later"]);
    release();
    await waiting;
  });

  test("C-API-37 guidance eligibility is fixed at enqueue, not rechecked at drain", async () => {
    const submitted: string[] = [];
    let release = (): void => {};
    let running = true;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      () => new Error("closed"),
      () => undefined,
      () => running,
    );
    queue.markReady();
    // Both guidances are submitted while ready + running, so both freeze
    // bypass-eligible. A later suspend/block does NOT reclassify the queued
    // second one back to readiness-waiting: its eligibility is already fixed.
    // (Dialog safety for a dialog that appears mid-submit is enforced at the
    // write layer, not by re-holding the queue.)
    const first = queue.send("first", "guidance");
    const second = queue.send("second", "guidance");
    running = false;
    queue.suspendReadiness();
    release();
    await first;
    expect(submitted).toEqual(["first", "second"]);
    release();
    await second;
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

  test("C-API-44 a throwing attach fails the op and never writes the text", async () => {
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
    await expect(
      queue.send("hello", "message", () => Promise.reject(new Error("attach boom"))),
    ).rejects.toThrow(/attach boom/);
    expect(writes).toEqual([]);
  });
});
