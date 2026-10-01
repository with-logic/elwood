/** Owned Stop combines with post-Enter idle, never cached readiness (C-API-48). */

import { afterEach, expect, test, vi } from "vitest";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks } from "../fixtures/owned-turn/session.ts";
import { becomeReady, ptys, resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  { priorStop: false, idleBeforeStop: false },
  { priorStop: false, idleBeforeStop: true },
  { priorStop: true, idleBeforeStop: false },
  { priorStop: true, idleBeforeStop: true },
])("C-API-48 own Stop requires post-Enter idle (prior Stop=$priorStop, early idle=$idleBeforeStop)", async ({
  priorStop,
  idleBeforeStop,
}) => {
  const { cwd, facade } = createFacadeFixture("codex");
  let result: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const pty = ptys[0]!;
    const paintIdle = () => pty.emitData(codexIdle);
    paintIdle();
    await live.terminal.settled();
    const { hook, stop } = nativeHooks("codex", live, cwd, pty);
    vi.useFakeTimers();
    result = facade.send("own").then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toContain("\r");
    await hook({ hook_event_name: "UserPromptSubmit", turn_id: "owned", prompt: "own" });
    if (priorStop) {
      await stop("prior");
      expect(live.status).toBe("ready");
    } else {
      expect(live.status).toBe("running");
    }
    if (idleBeforeStop) {
      paintIdle();
      await vi.advanceTimersByTimeAsync(50);
    }
    await stop("owned");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(idleBeforeStop);
    if (!idleBeforeStop) {
      await live.resize({ cols: 90, rows: 30 });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(settled).toBe(false);
      pty.emitData("\u001b[2J\u001b[HUnrecognized menu awaiting input");
      await vi.advanceTimersByTimeAsync(2_500);
      expect(settled).toBe(false); // Fresh output without a safe empty composer is insufficient.
      paintIdle();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(settled).toBe(true);
    }
    expect(await result).toBe("");
  } finally {
    vi.useRealTimers();
    await facade.close();
    await result;
  }
});

test("C-API-48 timeout and a no-op raw interrupt retain the unresolved current owner", async () => {
  const { cwd, facade } = createFacadeFixture("codex");
  let first: Promise<unknown> | undefined;
  let successor: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const pty = ptys[0]!;
    const { hook, stop } = nativeHooks("codex", live, cwd, pty);
    const pastes = () => pty.writes.filter((write) => write.startsWith("\u001b[200~"));
    vi.useFakeTimers();
    first = facade.send("same", { timeoutMs: 100 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await hook({ hook_event_name: "UserPromptSubmit", turn_id: "owned", prompt: "same" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ code: "wait_timeout" });
    successor = facade.send("same").catch((error: unknown) => error);
    await stop("prior");
    expect(live.status).toBe("ready");
    await live.interrupt();
    expect(pty.writes).not.toContain("\u001b");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pastes()).toHaveLength(1);
    const clears = () => pty.writes.filter((write) => write === composerClearKeys).length;
    const priorClears = clears();
    await stop("owned");
    pty.emitData(codexIdle);
    // Cancellation retains physical cleanup too: its clear must be acknowledged by later output.
    await vi.waitFor(() => expect(clears()).toBeGreaterThan(priorClears));
    expect(pastes()).toHaveLength(1);
    pty.emitData(codexIdle);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pastes()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await first;
    await successor;
  }
});
