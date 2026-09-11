/**
 * Shared hook dispatch (core/hook-dispatch.ts) through both adapter bindings:
 * fail-open classification and timeoutMs only on a genuine timeout.
 * Covers PRD §6.3 / §7A.2 and C-HOOK-03..06.
 */

import { describe, expect, test } from "vitest";
import { isBlock, requestHook } from "../../src/claude/hooks/dispatch.ts";
import { isCodexBlock, requestCodexHook } from "../../src/codex/hooks/dispatch.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { ClaudeEventMap, HookErrorEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

const claudeStop = {
  hook_event_name: "Stop" as const,
  session_id: "claude-1",
  cwd: "/tmp/project",
  stop_hook_active: false,
};

const codexStop = {
  hook_event_name: "Stop" as const,
  session_id: "codex-1",
  cwd: "/tmp/project",
  turn_id: "turn-1",
  stop_hook_active: false,
};

function collectErrors(emitter: TypedEmitter<ClaudeEventMap>): HookErrorEvent[] {
  const errors: HookErrorEvent[] = [];
  emitter.on("hookError", (event) => errors.push(event));
  return errors;
}

function codexEmitter(): TypedEmitter<CodexEventMap> {
  return new TypedEmitter<CodexEventMap>();
}

function collectCodexErrors(emitter: TypedEmitter<CodexEventMap>): HookErrorEvent[] {
  const errors: HookErrorEvent[] = [];
  emitter.on("hookError", (event) => errors.push(event));
  return errors;
}

describe("Claude hook dispatch timeout classification", () => {
  test("C-HOOK-04 a genuine timeout is categorized as timeout with timeoutMs", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    emitter.on("hook:Stop", () => new Promise(() => {}));
    const outcome = await requestHook(emitter, claudeStop, 5, "sess-1");
    expect(outcome.failedOpen).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.category).toBe("timeout");
    expect(errors[0]?.timeoutMs).toBe(5);
  });

  test('C-HOOK-05 a handler that throws Error("timeout") is a handler_error without timeoutMs', async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    emitter.on("hook:Stop", () => {
      throw new Error("timeout");
    });
    const outcome = await requestHook(emitter, claudeStop, 1000, "sess-1");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("handler_error");
    expect(errors[0]?.message).toBe("timeout");
    expect(errors[0]?.timeoutMs).toBeUndefined();
  });

  test("C-HOOK-05 a non-Error throw fails open with a generic handler_error message", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    emitter.on("hook:Stop", () => Promise.reject("boom"));
    const outcome = await requestHook(emitter, claudeStop, 1000, "sess-1");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("handler_error");
    expect(errors[0]?.message).toBe("Hook handler failed");
    expect(errors[0]?.timeoutMs).toBeUndefined();
  });

  test("C-HOOK-06 an invalid response fails open with invalid_response", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    emitter.on("hook:Stop", () => ({ decision: "nope" }));
    const outcome = await requestHook(emitter, claudeStop, 1000, "sess-1");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("invalid_response");
    expect(errors[0]?.timeoutMs).toBeUndefined();
  });

  test("C-HOOK-06 a valid response passes through without an error", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    emitter.on("hook:Stop", () => ({ decision: "block", reason: "stay" }));
    const outcome = await requestHook(emitter, claudeStop, 1000, "sess-1");
    expect(outcome.failedOpen).toBe(false);
    expect(outcome.result).toEqual({ decision: "block", reason: "stay" });
    expect(errors).toHaveLength(0);
  });

  test("C-HOOK-03 no registered listener fails open without an error", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors = collectErrors(emitter);
    const outcome = await requestHook(emitter, claudeStop, 1000, "sess-1");
    expect(outcome).toEqual({ result: undefined, failedOpen: false });
    expect(errors).toHaveLength(0);
  });
});

describe("Codex hook dispatch timeout classification", () => {
  test("C-HOOK-04 a genuine Codex timeout is categorized as timeout with timeoutMs", async () => {
    const emitter = codexEmitter();
    const errors = collectCodexErrors(emitter);
    emitter.on("hook:Stop", () => new Promise(() => {}));
    const outcome = await requestCodexHook(emitter, codexStop, 5, "sess-2");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("timeout");
    expect(errors[0]?.timeoutMs).toBe(5);
  });

  test('C-HOOK-05 a Codex handler throwing Error("timeout") is a handler_error', async () => {
    const emitter = codexEmitter();
    const errors = collectCodexErrors(emitter);
    emitter.on("hook:Stop", () => {
      throw new Error("timeout");
    });
    const outcome = await requestCodexHook(emitter, codexStop, 1000, "sess-2");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("handler_error");
    expect(errors[0]?.timeoutMs).toBeUndefined();
  });

  test("C-HOOK-05 a Codex non-Error rejection fails open generically", async () => {
    const emitter = codexEmitter();
    const errors = collectCodexErrors(emitter);
    emitter.on("hook:Stop", () => Promise.reject(42));
    const outcome = await requestCodexHook(emitter, codexStop, 1000, "sess-2");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.message).toBe("Hook handler failed");
  });

  test("C-HOOK-06 a Codex invalid response fails open with invalid_response", async () => {
    const emitter = codexEmitter();
    const errors = collectCodexErrors(emitter);
    emitter.on("hook:Stop", () => ({ decision: "nope" }));
    const outcome = await requestCodexHook(emitter, codexStop, 1000, "sess-2");
    expect(outcome.failedOpen).toBe(true);
    expect(errors[0]?.category).toBe("invalid_response");
  });

  test("C-HOOK-06 a valid Codex response passes through", async () => {
    const emitter = codexEmitter();
    emitter.on("hook:Stop", () => ({ decision: "block", reason: "stay" }));
    const outcome = await requestCodexHook(emitter, codexStop, 1000, "sess-2");
    expect(outcome.failedOpen).toBe(false);
    expect(outcome.result).toEqual({ decision: "block", reason: "stay" });
  });

  test("C-HOOK-03 no Codex listener fails open without an error", async () => {
    const emitter = codexEmitter();
    const errors = collectCodexErrors(emitter);
    const outcome = await requestCodexHook(emitter, codexStop, 1000, "sess-2");
    expect(outcome).toEqual({ result: undefined, failedOpen: false });
    expect(errors).toHaveLength(0);
  });
});

describe("hook block detection", () => {
  test("C-HOOK-06 isBlock recognizes only a block decision", () => {
    expect(isBlock({ decision: "block", reason: "stay" })).toBe(true);
    expect(isBlock({ decision: "approve" } as never)).toBe(false);
    expect(isBlock(undefined)).toBe(false);
  });

  test("C-HOOK-06 isCodexBlock recognizes block decisions and continue:false", () => {
    expect(isCodexBlock({ decision: "block", reason: "stay" })).toBe(true);
    expect(isCodexBlock({ continue: false, stopReason: "done" })).toBe(true);
    expect(isCodexBlock({ continue: true } as never)).toBe(false);
    expect(isCodexBlock(undefined)).toBe(false);
  });
});
