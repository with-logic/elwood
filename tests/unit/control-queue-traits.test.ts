/**
 * Unit tests for control-queue operation traits and enqueue-time bypass freezing.
 * Covers PRD §5.3, C-API-19, and C-API-37.
 */

import { describe, expect, test } from "vitest";
import { ControlQueue, controlOperationTraits } from "../../src/core/control-queue.ts";

describe("control-queue traits", () => {
  test("C-API-19 traits table pins per-operation readiness semantics", () => {
    expect(controlOperationTraits.message).toMatchObject({
      reportsCallerSubmission: true,
      consumesReadiness: true,
      readiness: "ready",
    });
    // Guidance's conditional policy is named explicitly, not a bare boolean.
    expect(controlOperationTraits.guidance).toEqual({
      reportsCallerSubmission: true,
      consumesReadiness: true,
      readiness: "running_after_ready",
      submitMode: "pasted_input",
    });
    expect(controlOperationTraits.prompt).toEqual({
      reportsCallerSubmission: true,
      consumesReadiness: true,
      readiness: "always",
      submitMode: "pasted_input",
    });
    // Compact is a command but still waits for readiness (runs after the turn).
    expect(controlOperationTraits.compact).toEqual({
      reportsCallerSubmission: false,
      consumesReadiness: false,
      readiness: "ready",
      submitMode: "command",
    });
    // Picker automation dispatches even mid-turn.
    for (const kind of ["list_models", "set_model"] as const) {
      expect(controlOperationTraits[kind]).toEqual({
        reportsCallerSubmission: false,
        consumesReadiness: false,
        readiness: "always",
        submitMode: "command",
      });
    }
  });

  test("C-API-37 guidance bypass eligibility is frozen at enqueue, not drain", async () => {
    const submitted: string[] = [];
    let running = false;
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => {
        running = true;
      },
      () => running,
    );
    // First readiness, then a message that starts a turn, then guidance queued
    // BEFORE that turn while still-not-running: it must NOT reclassify into the
    // turn the message starts, but wait for the next readiness like a message.
    queue.markReady();
    queue.suspendReadiness();
    const message = queue.send("message", "message");
    const guidance = queue.send("startup-safe-guidance", "guidance");
    // Only the message can dispatch on this readiness; guidance stays held.
    queue.markReady();
    await message;
    expect(submitted).toEqual(["message"]);
    // Guidance drains on the NEXT readiness, not by riding the message's turn.
    queue.markReady();
    await guidance;
    expect(submitted).toEqual(["message", "startup-safe-guidance"]);
  });
});
