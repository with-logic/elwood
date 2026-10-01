/** Selected loops retain uncertain writes and passive hook completion (C-API-48/50). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} selected loop keeps the caller until its own hook boundary`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const facade = agent === "claude" ? new ClaudeSession({ cwd }) : new CodexSession({ cwd });
    const live = await facade.start();
    const pty = helper.ptys[0]!;
    let caller: Promise<unknown> | undefined;
    const hook = (fields: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: `${agent}-1`,
        cwd,
        ...fields,
      });
    try {
      if (agent === "codex") await codex.becomeReady(live.elwoodSessionId, cwd);
      else
        await hook({
          hook_event_name: "InstructionsLoaded",
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      await expect.poll(() => live.status).toBe("ready");
      const send = vi.spyOn(live, "sendMessage");
      const write = pty.write.bind(pty);
      let failedEnter = false;
      vi.spyOn(pty, "write").mockImplementation((value) => {
        write(value);
        if (agent === "codex" && value === "\r" && !failedEnter) {
          failedEnter = true; // Dispatch can fail after bytes escaped to the native process.
          throw new Error("uncertain Enter completion");
        }
      });
      vi.useFakeTimers();
      const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "loop" });
      await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now() + 500);
      expect(pty.writes).toContain("\r");
      expect(failedEnter).toBe(agent === "codex");
      caller = facade.send("caller").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(send).not.toHaveBeenCalled();
      await hook({ hook_event_name: "UserPromptSubmit", prompt: "loop", turn_id: "loop" });
      pty.emitData(
        agent === "codex"
          ? "\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H"
          : `\u001b[2J\u001b[H${claudeTty(claudeComposer)}`,
      );

      await vi.advanceTimersByTimeAsync(100);
      await hook({
        hook_event_name: "Stop",
        turn_id: "loop",
        stop_hook_active: false,
        last_assistant_message: "",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await facade.close();
      await caller;
    }
  });
}
