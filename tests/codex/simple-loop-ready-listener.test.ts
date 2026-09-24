/** Reentrant caller reservations precede due-loop draining (PRD §5.8/§5.9, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-48 a caller reserved inside a ready listener precedes a due loop", async () => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let pending: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    vi.useFakeTimers();
    await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "loop" });
    const fired = vi.fn();
    live.on("loop", (event) => {
      if (event.kind === "fired") fired();
    });
    ptys[0]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(live.status).toBe("running");
    live.on("status", (event) => {
      if (event.status === "ready" && !pending) {
        pending = facade.send("caller").catch((error: unknown) => error);
      }
    });
    ptys[0]!.emitData("\u001b[2J\u001b[H■ Conversation interrupted\r\n› ");
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toBeDefined();
    expect(fired).not.toHaveBeenCalled();
    expect(ptys[0]!.writes.some((write) => write.includes("caller"))).toBe(true);
    expect(ptys[0]!.writes.some((write) => write.includes("loop"))).toBe(false);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});
