/** Finalized Stop contexts cannot admit input over the released successor (C-HOOK-04). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});
for (const agent of ["claude", "codex"] as const) {
  for (const method of ["sendPrompt", "sendMessage", "sendGuidance"] as const) {
    test.each([
      "handler",
      "hook",
      "activity",
      "observer-timeout",
      "hook-error",
      "error-activity",
    ] as const)(`C-HOOK-04 ${agent} finalized %s rejects late ${method} before admission`, async (mode) => {
      const timedOut = ["handler", "observer-timeout", "hook-error", "error-activity"].includes(
        mode,
      );
      const helper = agent === "claude" ? claude : codex;
      helper.installFakes();
      const cwd = helper.tempDir();
      let release = () => {};
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      let finished = false;
      let lateError: unknown;
      const callback = async () => {
        entered = true;
        await delayed;
        try {
          await session[method](
            "late callback",
            mode === "activity" && method === "sendGuidance"
              ? { images: [{ path: "/missing/expired-hook.png" }] }
              : undefined,
          );
        } catch (error) {
          lateError = error;
        }
        finished = true;
      };
      const session = await (agent === "claude" ? startClaude : startCodex)({
        cwd,
        hookTimeoutMs: 50,
        hooks: {
          Stop: async () => {
            if (mode === "handler") await callback();
            else if (timedOut) await delayed;
          },
        },
      });
      const events: {
        on(
          name: "hook",
          listener: (event: { readonly hook_event_name: string }) => unknown,
        ): unknown;
        on(
          name: "activity",
          listener: (event: { readonly kind: string; readonly hookEventName?: string }) => unknown,
        ): unknown;
        on(name: "hookError", listener: (event: { readonly category: string }) => unknown): unknown;
      } = session;
      if (mode === "hook" || mode === "observer-timeout")
        events.on("hook", (event) => {
          return event.hook_event_name === "Stop" ? callback() : undefined;
        });
      if (mode === "activity" || mode === "error-activity")
        events.on("activity", (event) => {
          return event.kind === (mode === "activity" ? "hook" : "hook_error") &&
            event.hookEventName === "Stop"
            ? callback()
            : undefined;
        });
      const pty = helper.ptys[0]!;
      let timeouts = 0;
      events.on("hookError", (event) => {
        if (event.category === "timeout") {
          timeouts++;
          if (mode === "hook-error") return callback();
        }
        return undefined;
      });
      try {
        vi.useFakeTimers();
        const first = session.sendPrompt("first");
        await vi.advanceTimersByTimeAsync(200);
        await first;
        const queued = session.sendMessage("queued successor");
        void queued.catch(() => undefined);
        const stop = pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: `${agent}-1`,
          cwd,
          turn_id: "turn-1",
          stop_hook_active: false,
        });
        await vi.waitFor(() => expect(entered).toBe(true));
        await vi.advanceTimersByTimeAsync(250);
        expect(await stop).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        await queued;
        expect(timeouts).toBe(timedOut ? 1 : 0);
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
        release();
        await vi.advanceTimersByTimeAsync(200);
        expect(finished).toBe(true);
        // Expiry wins before image validation, paste/attachment, and queue admission.
        expect(lateError).toMatchObject({ code: "wait_timeout" });
        expect(pty.writes.some((value) => value.includes("late callback"))).toBe(false);
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
        // An unrelated caller outside the expired callback still owns normal input.
        const outside = session.sendPrompt("outside caller");
        await vi.advanceTimersByTimeAsync(200);
        await outside;
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(3);
      } finally {
        release();
        vi.useRealTimers();
        await session.teardown();
      }
    });
  }
}
