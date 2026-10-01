/** Stop-released internal work has its own input authority (C-HOOK-04, C-LOOP-08). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodLoopEvent } from "../../src/core/loops/types.ts";
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
  test.each([
    "due-loop",
    "held-successor",
  ] as const)(`C-HOOK-04 ${agent} %s continuations survive the Stop that released them`, async (mode) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    // SessionLoops captures Date.now before fake timers begin; keep its clock live.
    // biome-ignore lint/complexity/useDateNow: calling the mocked method would recurse.
    vi.spyOn(Date, "now").mockImplementation(() => new Date().getTime());
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const events: {
      on(name: "loop", listener: (event: ElwoodLoopEvent) => void): unknown;
      on(name: "status", listener: (event: { readonly status: string }) => void): unknown;
    } = session;
    const pty = helper.ptys[0]!;
    const release = Promise.withResolvers<void>();
    let entered = false;
    let finished = false;
    let result: unknown;
    const follow = async () => {
      entered = true;
      await release.promise;
      try {
        await session.sendPrompt("independent follow-up");
        result = "sent";
      } catch (error) {
        result = error;
      }
      finished = true;
    };
    let successor: Promise<void> | undefined;
    try {
      vi.useFakeTimers();
      const first = session.sendPrompt("prior turn");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      if (mode === "due-loop") {
        events.on("loop", (event) => {
          if (event.kind === "fired" && !entered) void follow();
        });
        const loop = await session.createLoop({
          mode: "fixed",
          intervalMs: 60_000,
          message: "due loop",
        });
        await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now());
        expect((await session.listLoops())[0]?.state).toBe("due");
      } else {
        events.on("status", (event) => {
          if (event.status === "running" && !entered) void follow();
        });
        successor = session.sendMessage("held successor");
        void successor.catch(() => undefined);
      }
      expect(entered).toBe(false);
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "prior-turn",
        stop_hook_active: false,
      });
      await vi.advanceTimersByTimeAsync(200);
      await successor;
      expect(entered).toBe(true);
      release.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(finished).toBe(true);
      expect(result).toBe("sent");
      expect(pty.writes.filter((text) => text === "\r")).toHaveLength(3);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
