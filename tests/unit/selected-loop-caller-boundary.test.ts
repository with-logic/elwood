/**
 * Selected loop delivery drains before caller collection (C-API-48, PRD §5.9).
 * Uses the real facade, queue and hook bridge with a fake PTY. Derived from the
 * reviewed/main failing #119 evidence preserved at 7e44c827.
 */

import { afterEach, expect, test, vi } from "vitest";
import { becomeReady, ptys, resetFakes } from "../codex/helpers.ts";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks } from "../fixtures/owned-turn/session.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});
test.each([
  { prompt: "check", priorStop: false },
  { prompt: "  check  ", priorStop: false },
  { prompt: "  check  ", priorStop: true },
])("C-API-48 loop retains caller '$prompt' until own completion (prior Stop=$priorStop)", async ({
  prompt,
  priorStop,
}) => {
  const { cwd, facade } = createFacadeFixture("codex");
  let pending: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    const pty = ptys[0]!;
    const native = nativeHooks("codex", live, cwd, pty);
    const submissions: Array<string | undefined> = [];
    live.on("activity", (event) => {
      if (event.kind === "user_message") submissions.push(event.text);
    });
    vi.useFakeTimers();
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    const loop = await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now() + 1);
    expect(pty.writes.some((write) => write.includes("check"))).toBe(true);
    expect(fired).toBe(false);
    pending = facade.send(prompt).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toBe(true);
    expect(send).not.toHaveBeenCalled();
    if (priorStop) {
      await native.stop("prior-turn");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(send).not.toHaveBeenCalled();
    }
    await native.submit("loop-turn", "check");
    expect(submissions).toEqual(["check"]);
    pty.emitData(codexIdle);
    await vi.advanceTimersByTimeAsync(50);
    await native.stop("loop-turn");
    await vi.advanceTimersByTimeAsync(5000);
    expect(submissions).toEqual(["check"]);
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    await native.submit("caller-turn", "check");
    pty.emitData(codexIdle);
    await vi.advanceTimersByTimeAsync(50);
    await native.stop("caller-turn");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe("");
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
  }
});
