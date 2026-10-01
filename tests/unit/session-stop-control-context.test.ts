/** Non-turn queue work is neutral while caller Promise continuations retain Stop scope (C-HOOK-04). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { asScreen, claudePicker, codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "compact",
    "listModels",
  ] as const)(`C-HOOK-04 ${agent} %s settlement cannot lend expired Stop context to a successor`, async (method) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    let handleStop: () => undefined = () => undefined;
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      hooks: { Stop: () => handleStop() },
    });
    const pty = helper.ptys[0]!;
    const stop = () =>
      pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "prior-turn",
        stop_hook_active: false,
      });
    const release = Promise.withResolvers<void>();
    let followEntered = false;
    let followResult: unknown;
    let callerResult: unknown;
    let callerDone: Promise<void> | undefined;
    const events: {
      on(name: "status", listener: (event: { readonly status: string }) => void): unknown;
    } = session;
    try {
      vi.useFakeTimers();
      const first = session.sendPrompt("prior turn");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      await stop();
      expect(session.status).toBe("ready");
      events.on("status", (event) => {
        if (event.status !== "running" || followEntered) return;
        followEntered = true;
        void (async () => {
          await release.promise;
          try {
            await session.sendPrompt("independent follow-up");
            followResult = "sent";
          } catch (error) {
            followResult = error;
          }
        })();
      });
      handleStop = () => {
        // Register this reaction IN the caller's Stop context. Neutralizing internal
        // dispatch must not grant this late caller a new input lifetime.
        callerDone = session[method]()
          .then(async () => {
            await session.sendPrompt("late caller continuation");
            callerResult = "sent";
          })
          .catch((error: unknown) => {
            callerResult = error;
          });
        return undefined;
      };
      await stop();
      const successor = session.sendMessage("queued successor");
      void successor.catch(() => undefined);
      expect(followEntered).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      if (method === "listModels") {
        expect(pty.writes.join("")).toContain("/model\r");
        pty.emitData(asScreen(agent === "claude" ? claudePicker : codexPickerCurrentIsDefault));
        await vi.advanceTimersByTimeAsync(200);
        expect(pty.writes).toContain("\u001b");
        pty.emitData(asScreen(agent === "claude" ? "❯ " : "› "));
        await vi.advanceTimersByTimeAsync(200);
      } else {
        expect(pty.writes.join("")).toContain("/compact\r");
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "PostCompact",
          session_id: `${agent}-1`,
          cwd,
          model: "gpt-5.3-codex",
          turn_id: "prior-turn",
          trigger: "manual",
          compact_summary: "summary",
        });
      }
      await vi.advanceTimersByTimeAsync(200);
      await successor;
      expect(followEntered).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      await callerDone;
      release.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(followResult).toBe("sent");
      expect(pty.writes.some((text) => text.includes("independent follow-up"))).toBe(true);
      expect(callerResult).toMatchObject({ code: "wait_timeout" });
      expect(pty.writes.some((text) => text.includes("late caller continuation"))).toBe(false);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
