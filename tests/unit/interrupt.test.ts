/**
 * Unit tests for shared interrupt orchestration edges.
 * Covers PRD §5.3 and C-API-38.
 */

import { describe, expect, test } from "vitest";
import { interruptKey, sessionInterrupt } from "../../src/core/interrupt.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";

type StatusHandler = (event: { readonly status: ElwoodSessionStatus }) => void;

function statusEmitter() {
  const handlers: StatusHandler[] = [];
  return {
    on: (_event: "status", handler: StatusHandler) => {
      handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
    emit: (status: ElwoodSessionStatus) => {
      for (const handler of [...handlers]) handler({ status });
    },
  };
}

describe("sessionInterrupt", () => {
  test("C-API-38 the interrupt key is a bare Escape", () => {
    expect(interruptKey).toBe("\u001b");
  });

  test("C-API-38 no turn in flight resolves without sending Escape", async () => {
    let escapes = 0;
    const emitter = statusEmitter();
    const sendEscape = () => {
      escapes += 1;
      return Promise.resolve();
    };
    await sessionInterrupt(emitter, () => "ready", sendEscape, undefined);
    await sessionInterrupt(emitter, () => "starting", sendEscape, undefined);
    expect(escapes).toBe(0);
  });

  test("C-API-38 a running turn sends Escape and resolves on ready (default timeout)", async () => {
    let escapes = 0;
    const emitter = statusEmitter();
    const result = sessionInterrupt(
      emitter,
      () => "running",
      () => {
        escapes += 1;
        return Promise.resolve();
      },
      undefined,
    );
    // A non-ready, non-terminal status mid-wait is ignored.
    emitter.emit("blocked");
    emitter.emit("ready");
    await result;
    expect(escapes).toBe(1);
  });

  test("C-API-38 a blocked session is interruptible", async () => {
    let escapes = 0;
    const emitter = statusEmitter();
    const result = sessionInterrupt(
      emitter,
      () => "blocked",
      () => {
        escapes += 1;
        return Promise.resolve();
      },
      1_000,
    );
    emitter.emit("ready");
    await result;
    expect(escapes).toBe(1);
  });

  test("C-API-38 rejects with interrupt_failed when ready never arrives", async () => {
    const emitter = statusEmitter();
    const result = sessionInterrupt(
      emitter,
      () => "running",
      () => Promise.resolve(),
      20,
    );
    await expect(result).rejects.toMatchObject({ code: "interrupt_failed" });
  });

  test("C-API-38 rejects with session_not_running when the session terminates first", async () => {
    const emitter = statusEmitter();
    const result = sessionInterrupt(
      emitter,
      () => "running",
      () => Promise.resolve(),
      1_000,
    );
    emitter.emit("stopped");
    await expect(result).rejects.toMatchObject({ code: "session_not_running" });
  });

  test("C-API-38 a failed Escape write rejects the interrupt promise", async () => {
    const emitter = statusEmitter();
    const result = sessionInterrupt(
      emitter,
      () => "running",
      () => Promise.reject(new Error("terminal disposed")),
      1_000,
    );
    await expect(result).rejects.toThrow("terminal disposed");
  });

  test("C-API-38 a late Escape-write failure cannot unsettle a resolved interrupt", async () => {
    const emitter = statusEmitter();
    let rejectEscape!: (error: Error) => void;
    const escapeWrite = new Promise<void>((_, reject) => {
      rejectEscape = reject;
    });
    const result = sessionInterrupt(
      emitter,
      () => "running",
      () => escapeWrite,
      1_000,
    );
    emitter.emit("ready");
    await result;
    rejectEscape(new Error("late"));
    await result;
  });
});
