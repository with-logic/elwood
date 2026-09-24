/** Stop input expiry preserves existing admissions and independent callers (C-HOOK-04). */
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
for (const agent of ["claude", "codex"] as const)
  test.each([
    "pre-admitted",
    "internal-listener",
    "other-session",
    "non-stop",
    "raw",
    "diagnostic-admitted",
  ] as const)(`C-HOOK-04 ${agent} preserves %s input`, async (mode) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const start = agent === "claude" ? startClaude : startCodex;
    const cwd = helper.tempDir();
    let release = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let finished = false;
    let error: unknown;
    let pending: Promise<void> | undefined;
    const callback = async () => {
      entered = true;
      try {
        if (mode === "pre-admitted" || mode === "internal-listener") {
          // Admission precedes timeout/finalization; physical Enter settles later.
          pending = session.sendPrompt("admitted");
          if (mode === "pre-admitted") await pending;
        } else {
          await delayed;
          if (mode === "diagnostic-admitted") {
            finished = true;
            return;
          }
          if (mode === "raw") await session.sendKeys("allowed later");
          else await (mode === "other-session" ? other : session).sendPrompt("allowed later");
        }
        finished = true;
      } catch (caught) {
        error = caught;
      }
    };
    const session = await start({
      cwd,
      hookTimeoutMs: 50,
      hooks: {
        Stop: async () => {
          if (mode !== "non-stop") await callback();
        },
        UserPromptSubmit: async () => {
          if (mode === "non-stop") await callback();
        },
      },
    });
    const other = await start({ cwd: helper.tempDir() });
    const statusEvents: {
      on(name: "status", listener: (event: { readonly status: string }) => unknown): unknown;
    } = session;
    const errorEvents: {
      on(name: "hookError", listener: (event: { readonly category: string }) => unknown): unknown;
    } = session;
    if (mode === "diagnostic-admitted")
      errorEvents.on("hookError", (event) => {
        if (event.category !== "timeout") return;
        pending = session.sendPrompt("admitted");
        void pending.catch((caught) => {
          error = caught;
        });
      });
    const pty = helper.ptys[0]!;
    let listenerEntered = false;
    let listenerFinished = false;
    try {
      vi.useFakeTimers();
      const first = session.sendPrompt("first");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      if (mode === "internal-listener")
        statusEvents.on("status", async (event) => {
          if (event.status !== "running" || listenerEntered) return;
          listenerEntered = true;
          await delayed;
          try {
            await session.sendPrompt("status listener");
            listenerFinished = true;
          } catch (caught) {
            error = caught;
          }
        });
      const hook = pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: mode === "non-stop" ? "UserPromptSubmit" : "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "turn-1",
        stop_hook_active: false,
        prompt: "first",
      });
      await vi.waitFor(() => expect(entered).toBe(true));
      await vi.advanceTimersByTimeAsync(250);
      await hook;
      await pending;
      release();
      await vi.advanceTimersByTimeAsync(200);
      expect(finished).toBe(true);
      expect(error).toBeUndefined();
      const target = mode === "other-session" ? helper.ptys[1]! : pty;
      expect(
        target.writes.some((value) =>
          value.includes(
            mode === "pre-admitted" ||
              mode === "internal-listener" ||
              mode === "diagnostic-admitted"
              ? "admitted"
              : "allowed later",
          ),
        ),
      ).toBe(true);
      if (mode === "internal-listener") {
        expect(listenerEntered).toBe(true);
        expect(listenerFinished).toBe(true);
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(3);
      }
    } finally {
      release();
      vi.useRealTimers();
      await session.teardown();
      await other.teardown();
    }
  });
