/** Shared async dispatch wrappers stay inert for Codex too (C-HOOK-21). */
import { expect, test } from "vitest";
import { requestCodexHook } from "../../src/codex/hooks/dispatch.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { HookDispatchOutcome } from "../../src/core/hook-dispatch.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

for (const mode of ["response", "absent", "invalid", "timeout"] as const) {
  test(`C-HOOK-21 Codex ${mode} async wrappers never read inherited then`, async () => {
    const emitter = new TypedEmitter<CodexEventMap>();
    if (mode === "response") emitter.on("hook:Stop", () => ({ decision: "block", reason: "wait" }));
    if (mode === "invalid") emitter.on("hook:Stop", () => 42);
    if (mode === "timeout") emitter.on("hook:Stop", () => new Promise(() => {}));
    const event = {
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "/tmp",
      turn_id: "turn-1",
      stop_hook_active: false,
    } as const;
    let reads = 0;
    // biome-ignore lint/suspicious/noThenProperty: inherited then is the regression input.
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        // Vitest also resolves an unrelated array while a real timeout is pending.
        if (!Array.isArray(this)) reads += 1;
        return undefined;
      },
    });
    let outcome: HookDispatchOutcome<unknown>;
    try {
      outcome = await requestCodexHook(emitter, event, 5, "e1");
    } finally {
      Reflect.deleteProperty(Object.prototype, "then");
    }
    expect(reads).toBe(0);
    expect(outcome.failedOpen).toBe(mode === "invalid" || mode === "timeout");
    if (mode === "response") expect(outcome.result).toEqual({ decision: "block", reason: "wait" });
  });
}
