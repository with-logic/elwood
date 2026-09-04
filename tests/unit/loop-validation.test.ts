/**
 * Unit and compile-time coverage for recurring-loop domain types and validation.
 * Covers PRD §5.9 and C-LOOP-02/C-LOOP-03/C-LOOP-10.
 */

import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  MAX_ACTIVE_LOOPS,
  MAX_LOOP_INTERVAL_MS,
  MAX_LOOP_MESSAGE_BYTES,
  MIN_LOOP_INTERVAL_MS,
} from "../../src/core/loops/constants.ts";
import { validateLoopRequest } from "../../src/core/loops/validate.ts";
import type {
  ElwoodLoopEvent,
  ElwoodLoopEventSnapshot,
  ElwoodLoopRequest,
  ElwoodLoopSnapshot,
} from "../../src/index.ts";

function invalidRequest(request: unknown): ElwoodError {
  try {
    validateLoopRequest(request);
    throw new Error("expected invalid_loop");
  } catch (error) {
    if (error instanceof ElwoodError) return error;
    throw error;
  }
}

describe("validateLoopRequest", () => {
  test("C-LOOP-02 returns normalized fixed and idle requests", () => {
    expect(validateLoopRequest({ mode: "idle", message: " " })).toEqual({
      mode: "idle",
      message: " ",
    });
    expect(
      validateLoopRequest({ mode: "fixed", intervalMs: MIN_LOOP_INTERVAL_MS, message: "go" }),
    ).toEqual({ mode: "fixed", intervalMs: 60_000, message: "go" });
  });

  test("C-LOOP-03 enforces inclusive message-byte boundaries using UTF-8", () => {
    expect(
      validateLoopRequest({ mode: "idle", message: "x".repeat(MAX_LOOP_MESSAGE_BYTES) }),
    ).toMatchObject({ mode: "idle" });
    expect(invalidRequest({ mode: "idle", message: "" }).code).toBe("invalid_loop");
    expect(invalidRequest({ mode: "idle", message: "é".repeat(32_769) }).code).toBe("invalid_loop");
  });

  test("C-LOOP-03 enforces fixed integer and interval boundaries", () => {
    expect(
      validateLoopRequest({
        mode: "fixed",
        intervalMs: MAX_LOOP_INTERVAL_MS - 1,
        message: "valid",
      }),
    ).toMatchObject({ intervalMs: 604_799_999 });
    for (const intervalMs of [
      MIN_LOOP_INTERVAL_MS - 1,
      MAX_LOOP_INTERVAL_MS,
      60_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "60000",
    ]) {
      expect(invalidRequest({ mode: "fixed", intervalMs, message: "invalid" }).code).toBe(
        "invalid_loop",
      );
    }
  });

  test("C-LOOP-03 rejects malformed discriminated request shapes", () => {
    for (const request of [
      null,
      [],
      "idle",
      {},
      { mode: "other", message: "x" },
      { mode: "idle", message: 1 },
      { mode: "idle", intervalMs: 60_000, message: "x" },
      { mode: "fixed", message: "x" },
    ]) {
      expect(invalidRequest(request).code).toBe("invalid_loop");
    }
  });

  test("C-LOOP-10 invalid errors never expose prompt text or serialized requests", () => {
    const secret = "private prompt";
    const error = invalidRequest({ mode: "fixed", intervalMs: 1, message: secret });
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });
});

describe("public loop domain", () => {
  test("C-LOOP-02 exports readonly request, snapshot, redaction, and event types", () => {
    const request: ElwoodLoopRequest = { mode: "idle", message: "check" };
    const snapshot: ElwoodLoopSnapshot = {
      id: "loop-1",
      message: "check",
      mode: "idle",
      jitterMs: 10,
      createdAt: 1,
      expiresAt: 2,
      state: "scheduled",
      nextDueAt: 3,
    };
    const redacted: ElwoodLoopEventSnapshot = {
      id: snapshot.id,
      mode: snapshot.mode,
      jitterMs: snapshot.jitterMs,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      state: snapshot.state,
      nextDueAt: 3,
    };
    const event: ElwoodLoopEvent = {
      kind: "created",
      loopId: snapshot.id,
      at: 4,
      snapshot: redacted,
    };
    const proveReadonly = (value: ElwoodLoopRequest, view: ElwoodLoopSnapshot): void => {
      // @ts-expect-error Public loop requests are readonly.
      value.message = "changed";
      // @ts-expect-error Public loop snapshots are readonly.
      view.state = "due";
    };

    expect(event.snapshot).not.toHaveProperty("message");
    expect(request.mode).toBe("idle");
    expect(typeof proveReadonly).toBe("function");
    expect(MAX_ACTIVE_LOOPS).toBe(50);
  });
});
