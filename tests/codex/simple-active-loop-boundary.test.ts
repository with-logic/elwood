/** Accepted loop hooks cannot bind a later caller (PRD §5.8/§5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "staging",
  "committed",
])("C-API-48 a %s loop cannot accept a later caller", async (phase) => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    vi.useFakeTimers();
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(
      loop.nextDueAt! - Date.now() + (phase === "staging" ? 1 : 500),
    );
    if (phase === "committed") await vi.waitFor(() => expect(fired).toBe(true));
    else {
      expect(ptys[0]!.writes.some((write) => write.includes("check"))).toBe(true);
      expect(fired).toBe(false);
    }
    pending = facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(fired).toBe(true));
    const paint = async (text: string) => {
      ptys[0]!.emitData(`\u001b[2J\u001b[H${text}\r\n› `);
      await vi.advanceTimersByTimeAsync(100);
    };
    await ptys[0]!.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      prompt: "check",
      turn_id: "loop-turn",
    });
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    let submitted = false;
    void send.mock.results[0]!.value.then(() => {
      submitted = true;
    });
    await vi.waitFor(() => expect(submitted).toBe(true));
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});

test.each([
  "staging",
  "committed",
])("C-API-48 close cancels a caller waiting on a %s loop", async (phase) => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    vi.useFakeTimers();
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(
      loop.nextDueAt! - Date.now() + (phase === "staging" ? 1 : 500),
    );
    if (phase === "committed") await vi.waitFor(() => expect(fired).toBe(true));
    else expect(fired).toBe(false);
    pending = facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await facade.close();
    expect(await pending).toMatchObject({ code: "session_not_running" });
    expect(send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});

test("C-API-48 cancelling a staged loop releases its waiting caller", async () => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    vi.useFakeTimers();
    const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now() + 1);
    expect(ptys[0]!.writes.some((write) => write.includes("check"))).toBe(true);
    pending = facade.send("caller").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await facade.cancelLoop(loop.id);
    await vi.waitFor(() => expect(ptys[0]!.writes).toContain("\u0015\u000b"));
    ptys[0]!.emitData("\u001b[2J\u001b[H› \r\n  gpt-5.3-codex high\u001b[1;3H");
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await expect(facade.listLoops()).resolves.toEqual([]);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});
