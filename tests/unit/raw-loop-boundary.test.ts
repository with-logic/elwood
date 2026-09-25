/** Raw input waits for a selected loop's transcript while controls pass (PRD §5.8/§5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { loopFacade, resetLoopFacades } from "../helpers/loop-facade.ts";

afterEach(resetLoopFacades);

const cases = (["claude", "codex"] as const).flatMap((agent) =>
  (["sendMessage", "sendPrompt", "sendGuidance"] as const).flatMap((method) =>
    [false, true].map((cancel) => ({ agent, method, cancel })),
  ),
);

test.each(
  cases,
)("C-LOOP-08 $agent $method waits for trailing loop output (cancel=$cancel)", async ({
  agent,
  method,
  cancel,
}) => {
  const f = await loopFacade(agent);
  let pending: Promise<unknown> | undefined;
  try {
    const fired: string[] = [];
    f.live.on("loop", (event) => {
      if (event.kind === "fired") fired.push(event.loopId);
    });
    const loop = await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "loop" });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(fired).toEqual([loop.id]);
    await f.submitted("loop");
    await f.stop("LOOP");
    if (cancel) await f.facade.cancelLoop(loop.id);
    let settled = false;
    pending = f.live[method]("raw caller").then(
      () => {
        settled = true;
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    expect(f.pty.writes.some((write) => write.includes("\u001b[200~raw caller"))).toBe(false);
    expect((await f.picker()).length).toBeGreaterThan(0);
    f.append("LOOP");
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5000 });
    expect(f.pty.writes.some((write) => write.includes("\u001b[200~raw caller"))).toBe(true);
  } finally {
    await f.close();
    await pending;
  }
});

test.each([
  "claude",
  "codex",
] as const)("C-LOOP-08 %s close rejects parked raw input without writing", async (agent) => {
  const f = await loopFacade(agent);
  let pending: Promise<unknown> | undefined;
  try {
    await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "loop" });
    await vi.advanceTimersByTimeAsync(110_000);
    await f.submitted("loop");
    await f.stop("LOOP");
    pending = f.live.sendPrompt("raw caller").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3000);
    await f.close();
    await expect(pending).resolves.toMatchObject({ code: "session_not_running" });
    expect(f.pty.writes.some((write) => write.includes("\u001b[200~raw caller"))).toBe(false);
  } finally {
    await f.close();
    await pending;
  }
});
