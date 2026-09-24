/** Real adapter facades drain scheduled-loop tails before callers (PRD §5.8, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { loopFacade, resetLoopFacades } from "../helpers/loop-facade.ts";

afterEach(resetLoopFacades);

test.each([
  "claude",
  "codex",
] as const)("C-API-48 %s waits for delayed Stop and transcript after rendered loop readiness", async (agent) => {
  const f = await loopFacade(agent);
  let result: Promise<unknown> | undefined;
  try {
    let fired = false;
    f.live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    await f.facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(fired).toBe(true));
    const send = vi.spyOn(f.live, "sendMessage");
    result = f.facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await f.submitted("check");
    await f.renderReady();
    expect(f.live.status).toBe("ready");
    expect(send).not.toHaveBeenCalled();
    await f.hook({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "LOOP",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send).not.toHaveBeenCalled();
    f.append("LOOP");
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 5_000 });
    let written = false;
    void send.mock.results[0]!.value.then(() => {
      written = true;
    });
    await vi.waitFor(() => expect(written).toBe(true));
    await f.submitted("caller");
    f.append("CALLER");
    await f.stop("CALLER");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toBe("CALLER");
  } finally {
    await f.close();
    await result;
  }
});
