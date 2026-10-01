/** Owned Stop combines with post-Enter idle, never cached readiness (C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

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
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let result: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const pty = ptys[0]!;
    const paintIdle = () =>
      pty.emitData(
        "\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H",
      );
    paintIdle();
    await live.terminal.settled();
    const hook = (input: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: "codex-1",
        cwd,
        ...input,
      });
    const stop = (turn_id: string) =>
      hook({
        hook_event_name: "Stop",
        turn_id,
        stop_hook_active: false,
        last_assistant_message: "",
      });
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
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd });
  let first: Promise<unknown> | undefined;
  let successor: Promise<unknown> | undefined;
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => live.status).toBe("ready");
    const pty = ptys[0]!;
    const hook = (input: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: "codex-1",
        cwd,
        ...input,
      });
    const stop = (turn_id: string) =>
      hook({
        hook_event_name: "Stop",
        turn_id,
        stop_hook_active: false,
        last_assistant_message: "",
      });
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
    pty.emitData("\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H");
    // Cancellation retains physical cleanup too: its clear must be acknowledged by later output.
    await vi.waitFor(() => expect(clears()).toBeGreaterThan(priorClears));
    expect(pastes()).toHaveLength(1);
    pty.emitData("\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pastes()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await first;
    await successor;
  }
});
