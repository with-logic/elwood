/** Hook-observer diagnostics retain Stop's input lifetime (PRD §6.3, C-HOOK-04). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-HOOK-04 ${agent} warning observer continuation cannot input after Stop`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const events: {
      on(name: "hook", listener: (event: { readonly hook_event_name: string }) => unknown): unknown;
      on(name: "warning", listener: (event: { readonly code: string }) => unknown): unknown;
    } = session;
    const release = Promise.withResolvers<void>();
    let late: Promise<unknown> | undefined;
    events.on("hook", (event) => {
      if (event.hook_event_name === "Stop") throw new Error("private observer failure");
    });
    events.on("warning", (event) => {
      if (event.code !== "hook_observer_failed") return;
      late = release.promise.then(() =>
        session.sendPrompt("late diagnostic input").then(
          () => "sent",
          (error: unknown) => error,
        ),
      );
    });
    const pty = helper.ptys[0]!;
    try {
      vi.useFakeTimers();
      const first = session.sendPrompt("first");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      const stop = pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "turn-1",
        stop_hook_active: false,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await stop).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(late).toBeDefined();
      release.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(await late).toMatchObject({ code: "wait_timeout" });
      expect(pty.writes.some((value) => value.includes("late diagnostic input"))).toBe(false);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
