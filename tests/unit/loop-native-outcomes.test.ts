/** Selected loops retain uncertain writes and passive hook completion (C-API-48/50). */

import { afterEach, expect, test, vi } from "vitest";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  resetAdapters();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} selected loop keeps the caller until its own hook boundary`, async () => {
    const { helper, cwd, facade } = createFacadeFixture(agent);
    const live = await facade.start();
    const pty = helper.ptys[0]!;
    let caller: Promise<unknown> | undefined;
    const { hook, ready } = nativeHooks(agent, live, cwd, pty);
    try {
      await ready();
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
      pty.emitData(agent === "codex" ? codexIdle : `\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);

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
