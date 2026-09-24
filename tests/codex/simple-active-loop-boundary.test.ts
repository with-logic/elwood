/** Loop cancellation and shutdown release waiting facade turns (PRD §5.8/§5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { loopFacade, resetLoopFacades } from "../helpers/loop-facade.ts";

afterEach(resetLoopFacades);

test.each([
  "staging",
  "committed",
])("C-API-48 close cancels a caller waiting on a %s loop", async (phase) => {
  const f = await loopFacade("codex");
  let pending: Promise<unknown> | undefined;
  try {
    const send = vi.spyOn(f.live, "sendMessage");
    let fired = false;
    f.live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    const loop = await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(
      loop.nextDueAt! - Date.now() + (phase === "staging" ? 1 : 500),
    );
    if (phase === "committed") await vi.waitFor(() => expect(fired).toBe(true));
    else expect(fired).toBe(false);
    pending = f.facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await f.facade.close();
    expect(await pending).toMatchObject({ code: "session_not_running" });
    expect(send).not.toHaveBeenCalled();
  } finally {
    await f.close();
    await pending;
  }
});

test("C-API-48 cancelling a staged loop releases its waiting caller", async () => {
  const f = await loopFacade("codex");
  let pending: Promise<unknown> | undefined;
  try {
    const send = vi.spyOn(f.live, "sendMessage");
    const loop = await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now() + 1);
    expect(f.pty.writes.some((write) => write.includes("check"))).toBe(true);
    pending = f.facade.send("caller").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await f.facade.cancelLoop(loop.id);
    await vi.waitFor(() => expect(f.pty.writes).toContain("\u0015\u000b"));
    f.pty.emitData("\u001b[2J\u001b[H› \r\n  gpt-5.3-codex high\u001b[1;3H");
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await expect(f.facade.listLoops()).resolves.toEqual([]);
  } finally {
    await f.close();
    await pending;
  }
});
