/** Real facade and loop scheduling share one caller boundary (PRD §5.8/§5.9, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  false,
  true,
])("C-API-48 due loops wait through caller recovery and queued successor=%s", async (queued) => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  let successor: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    vi.useFakeTimers();
    await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    pending = facade.send("check").catch((error: unknown) => error);
    if (queued) successor = facade.send("successor").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).toHaveBeenCalledOnce();
    const paint = async (text: string) => {
      ptys[0]!.emitData(`\u001b[2J\u001b[H${text}\r\n› `);
      await vi.advanceTimersByTimeAsync(100);
    };
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(fired).toBe(false);
    let replaySubmitted = false;
    void send.mock.results[1]!.value.then(() => {
      replaySubmitted = true;
    });
    await vi.waitFor(() => expect(replaySubmitted).toBe(true));
    await ptys[0]!.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      prompt: "check",
      turn_id: "caller-turn",
    });
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    await expect(pending).resolves.toBe("");
    if (queued) {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      expect(fired).toBe(false);
      let submitted = false;
      void send.mock.results[2]!.value.then(() => {
        submitted = true;
      });
      await vi.waitFor(() => expect(submitted).toBe(true));
      await ptys[0]!.dispatchHook(live.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-1",
        cwd,
        prompt: "successor",
        turn_id: "successor-turn",
      });
      await paint("• Working (3s • esc to interrupt)");
      await paint("■ Conversation interrupted");
      await vi.advanceTimersByTimeAsync(2100);
      await expect(successor).resolves.toBe("");
    }
    await vi.waitFor(() => expect(fired).toBe(true));
    expect(send).toHaveBeenCalledTimes(queued ? 3 : 2);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
    await successor;
  }
});
