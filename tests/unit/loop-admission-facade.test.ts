/** Parked loop reservations preserve controls, cancellation and caller order (PRD §5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { loopFacade, resetLoopFacades } from "../helpers/loop-facade.ts";

afterEach(resetLoopFacades);

test.each([
  { agent: "claude", cancel: false },
  { agent: "claude", cancel: true },
  { agent: "codex", cancel: false },
  { agent: "codex", cancel: true },
] as const)("C-LOOP-08 $agent parked successor preserves controls (cancel=$cancel)", async ({
  agent,
  cancel,
}) => {
  const f = await loopFacade(agent);
  let caller: Promise<unknown> | undefined;
  try {
    const fired: string[] = [];
    f.live.on("loop", (event) => {
      if (event.kind === "fired") fired.push(event.loopId);
    });
    const a = await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "A" });
    const b = await f.facade.createLoop({ mode: "fixed", intervalMs: 90_000, message: "B" });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(fired).toEqual([a.id]);
    await f.submitted("A");
    await f.stop("A");
    await vi.advanceTimersByTimeAsync(100);
    const send = vi.spyOn(f.live, "sendMessage");
    caller = f.facade.send("caller").catch((error: unknown) => error);
    if (cancel) await f.facade.cancelLoop(b.id);
    expect((await f.picker()).length).toBeGreaterThan(0);
    expect(send).not.toHaveBeenCalled();
    expect(fired).toEqual([a.id]);
    expect(f.pty.writes.some((write) => write.includes("\u001b[200~B"))).toBe(false);
    f.append("A");
    if (!cancel) {
      await vi.waitFor(() => expect(fired).toEqual([a.id, b.id]), { timeout: 5000 });
      expect(send).not.toHaveBeenCalled();
      await f.submitted("B");
      await f.stop("B");
      await vi.advanceTimersByTimeAsync(3000);
      expect(send).not.toHaveBeenCalled();
      f.append("B");
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 5000 });
    let written = false;
    void send.mock.results[0]!.value.then(() => {
      written = true;
    });
    await vi.waitFor(() => expect(written).toBe(true));
    await f.submitted("caller");
    f.append("CALLER");
    await f.stop("CALLER");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(caller).resolves.toBe("CALLER");
    if (cancel) expect(fired).not.toContain(b.id);
  } finally {
    await f.close();
    await caller;
  }
});
