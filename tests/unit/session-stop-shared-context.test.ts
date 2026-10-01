/** Shared observer diagnostics preserve internal contexts without enforcing public input (C-HOOK-04/22). */
import { afterEach, expect, test, vi } from "vitest";
import { assertStopInput } from "../../src/core/stop-input.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    false,
    true,
  ])(`C-HOOK-04 ${agent} shared promise diagnostics retain distinct contexts (Stop first=%s)`, async (stopFirst) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const events: {
      on(name: "hook", handler: (event: { readonly hook_event_name: string }) => unknown): unknown;
      on(
        name: "activity",
        handler: (event: { readonly kind: string; readonly hookEventName?: string }) => unknown,
      ): unknown;
      on(
        name: "warning",
        handler: (event: { readonly code: string; readonly phase?: string }) => unknown,
      ): unknown;
    } = session;
    const pending = Promise.withResolvers<void>();
    // Return the SAME native Promise at both registration sites.
    events.on("hook", (event) => (event.hook_event_name === "Stop" ? pending.promise : undefined));
    events.on("activity", (event) =>
      event.kind === "user_message" && event.hookEventName === "UserPromptSubmit"
        ? pending.promise
        : undefined,
    );
    const outcomes = new Map<string, unknown>();
    const warnings: string[] = [];
    events.on("warning", (event) => {
      if (event.code !== "hook_observer_failed") return;
      const phase = event.phase!;
      warnings.push(phase);
      // Distinct native hook phases identify the original registration, not rejection order.
      try {
        assertStopInput(session);
        outcomes.set(phase, "open");
      } catch (error) {
        outcomes.set(phase, error);
      }
    });
    const pty = helper.ptys[0]!;
    try {
      vi.useFakeTimers();
      const names = stopFirst ? ["Stop", "UserPromptSubmit"] : ["UserPromptSubmit", "Stop"];
      for (const name of names) {
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: name,
          session_id: `${agent}-1`,
          cwd,
          turn_id: "first-turn",
          prompt: "first",
          stop_hook_active: false,
        });
      }
      expect(warnings).toEqual([]);
      pending.reject(new Error("shared late observer failure"));
      await vi.advanceTimersByTimeAsync(500);
      expect(warnings.sort()).toEqual(["activity", "hook"]);
      expect.soft(outcomes.get("activity")).toBe("open");
      expect.soft(outcomes.get("hook")).toMatchObject({ code: "wait_timeout" });
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
