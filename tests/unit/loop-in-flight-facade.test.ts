/** Actual facades fence loop hooks during and after physical staging (PRD §5.8, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { loopFacade, resetLoopFacades } from "../helpers/loop-facade.ts";
import { asScreen } from "../helpers/model-pickers.ts";

afterEach(resetLoopFacades);

test.each([
  { agent: "claude", phase: "staging" },
  { agent: "claude", phase: "committed" },
  { agent: "codex", phase: "staging" },
  { agent: "codex", phase: "committed" },
] as const)("C-API-48 $agent $phase loop cannot accept a later caller", async ({
  agent,
  phase,
}) => {
  const f = await loopFacade(agent);
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
    else {
      expect(f.pty.writes.some((write) => write.includes("check"))).toBe(true);
      expect(fired).toBe(false);
    }
    pending = f.facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fired).toBe(true));
    await f.submitted("check");
    await f.stop("");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 5000 });
    let writes = 0;
    void send.mock.results[0]!.value.then(() => {
      writes += 1;
    });
    await vi.waitFor(() => expect(writes).toBe(1));
    // No caller acceptance arrives: an unrelated ready transition must cause replay.
    f.pty.emitData(
      asScreen(
        agent === "claude"
          ? "❯ \n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents"
          : "• Working (3s • esc to interrupt)\n› ",
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    f.pty.emitData(
      asScreen(
        agent === "claude"
          ? "❯ \n  ⏵⏵ bypass permissions · ← for agents"
          : "■ Conversation interrupted\n› ",
      ),
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 5000 });
    void send.mock.results[1]!.value.then(() => {
      writes += 1;
    });
    await vi.waitFor(() => expect(writes).toBe(2));
    await f.submitted("check");
    await f.stop("");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe("");
  } finally {
    await f.close();
    await pending;
  }
});
