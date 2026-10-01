/** Loops created by Stop outlive its callback authority (C-HOOK-04, C-LOOP-05). */
import { afterEach, expect, test, vi } from "vitest";
import * as timers from "../../src/core/loops/timers.ts";
import type { ElwoodLoopEvent } from "../../src/core/loops/types.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-HOOK-04 ${agent} Stop-created loop timer admits independent fired input`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    // Real timers preserve AsyncLocalStorage; shorten only the due timer at its seam.
    const schedule = timers.scheduleLoopTimer;
    vi.spyOn(timers, "scheduleLoopTimer").mockImplementation((run, delay) =>
      schedule(run, delay < 120_000 ? 30 : delay),
    );
    const cwd = helper.tempDir();
    const release = Promise.withResolvers<void>();
    let late: Promise<unknown> | undefined;
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      hooks: {
        Stop: async () => {
          await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "timer loop" });
          // Scheduler detachment must restore this callback's expiring authority.
          late = release.promise.then(() =>
            session.sendPrompt("late Stop input").then(
              () => "sent",
              (error: unknown) => error,
            ),
          );
        },
      },
    });
    const pty = helper.ptys[0]!;
    const outcome = Promise.withResolvers<unknown>();
    const events: { on(name: "loop", listener: (event: ElwoodLoopEvent) => void): unknown } =
      session;
    events.on("loop", (event) => {
      if (event.kind !== "fired") return;
      void session.cancelLoop(event.loopId);
      void session.sendPrompt("timer follow-up").then(
        () => outcome.resolve("sent"),
        (error: unknown) => outcome.resolve(error),
      );
    });
    try {
      await session.sendPrompt("prior turn");
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "prior-turn",
        stop_hook_active: false,
      });
      release.resolve();
      await expect(late).resolves.toMatchObject({ code: "wait_timeout" });
      await expect(outcome.promise).resolves.toBe("sent");
      expect(pty.writes.filter((text) => text === "\r")).toHaveLength(3);
    } finally {
      release.resolve();
      await session.teardown();
    }
  });
}
