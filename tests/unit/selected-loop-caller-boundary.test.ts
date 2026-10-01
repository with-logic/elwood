/**
 * Selected loop delivery drains before caller collection (C-API-48, PRD §5.9).
 * Uses the real facade, queue and hook bridge with a fake PTY. Derived from the
 * reviewed/main failing #119 evidence preserved at 7e44c827.
 */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});
test.each([
  { prompt: "check", priorStop: false },
  { prompt: "  check  ", priorStop: false },
  { prompt: "  check  ", priorStop: true },
])("C-API-48 loop retains caller '$prompt' until own completion (prior Stop=$priorStop)", async ({
  prompt,
  priorStop,
}) => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    const pty = ptys[0]!;
    const submissions: Array<string | undefined> = [];
    live.on("activity", (event) => {
      if (event.kind === "user_message") submissions.push(event.text);
    });
    vi.useFakeTimers();
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now() + 1);
    expect(pty.writes.some((write) => write.includes("check"))).toBe(true);
    expect(fired).toBe(false);
    pending = facade.send(prompt).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toBe(true);
    expect(send).not.toHaveBeenCalled();
    if (priorStop) {
      await pty.dispatchHook(live.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: "codex-1",
        cwd,
        turn_id: "prior-turn",
        stop_hook_active: false,
        last_assistant_message: "",
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(send).not.toHaveBeenCalled();
    }
    await pty.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      prompt: "check",
      turn_id: "loop-turn",
    });
    expect(submissions).toEqual(["check"]);
    pty.emitData("\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H");
    await vi.advanceTimersByTimeAsync(50);
    await pty.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      turn_id: "loop-turn",
      stop_hook_active: false,
      last_assistant_message: "",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(submissions).toEqual(["check"]);
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    await pty.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      prompt: "check",
      turn_id: "caller-turn",
    });
    pty.emitData("\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H");
    await vi.advanceTimersByTimeAsync(50);
    await pty.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      turn_id: "caller-turn",
      stop_hook_active: false,
      last_assistant_message: "",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe("");
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});
