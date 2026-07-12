/**
 * Unit tests for the typed control-operation queue.
 * Covers PRD §5.3 and C-API-19.
 */

import { describe, expect, test } from "vitest";
import {
  ControlQueue,
  type ControlSubmitMode,
  controlOperationTraits,
} from "../../src/core/control-queue.ts";

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
      "message",
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
    // A picker command queued behind the pending message must not jump ahead.
    const queuedCommand = queue.send("/model", "set_model");
    expect(submitted).toEqual(["/model"]);
    queue.markReady();
    await Promise.all([queuedMessage, queuedCommand]);
    expect(submitted).toEqual(["/model", "hello", "/model"]);
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

  test("C-API-37 queued guidance rechecks blocking state before dispatch", async () => {
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
    const first = queue.send("first", "guidance");
    const second = queue.send("hold-while-blocked", "guidance");
    running = false;
    queue.suspendReadiness();
    release();
    await first;
    expect(submitted).toEqual(["first"]);
    running = true;
    queue.markReady();
    expect(submitted).toEqual(["first", "hold-while-blocked"]);
    release();
    await second;
  });

  test("C-API-19 traits table pins per-operation readiness semantics", () => {
    expect(controlOperationTraits.message).toMatchObject({
      startsTurn: true,
      consumesReadiness: true,
      waitsForReadiness: true,
    });
    expect(controlOperationTraits.guidance).toEqual({
      startsTurn: true,
      consumesReadiness: true,
      waitsForReadiness: true,
      submitMode: "message",
    });
    expect(controlOperationTraits.readiness_bypass).toEqual({
      startsTurn: true,
      consumesReadiness: true,
      waitsForReadiness: false,
      submitMode: "message",
    });
    // Compact is a command but still waits for readiness (runs after the turn).
    expect(controlOperationTraits.compact).toEqual({
      startsTurn: false,
      consumesReadiness: false,
      waitsForReadiness: true,
      submitMode: "command",
    });
    // Picker automation dispatches even mid-turn.
    for (const kind of ["list_models", "set_model"] as const) {
      expect(controlOperationTraits[kind]).toEqual({
        startsTurn: false,
        consumesReadiness: false,
        waitsForReadiness: false,
        submitMode: "command",
      });
    }
  });
});
