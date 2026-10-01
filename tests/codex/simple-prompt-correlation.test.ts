/** The public Codex facade applies native prompt identity only to correlation (C-API-48/40). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-48 send accepts native transformed text while forwarding the raw caller prompt", async () => {
  installFakes();
  const cwd = tempDir();
  const simple = new CodexSession({ cwd });
  try {
    const session = await simple.start();
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const send = vi.spyOn(session, "sendMessage").mockResolvedValue();
    const raw = "  a\u0001b\tword\rlast  ";
    vi.useFakeTimers();
    const result = simple.send(raw).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledExactlyOnceWith(raw, undefined);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      prompt: "ab\tword\nlast",
      turn_id: "native-turn",
    });
    ptys[0]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
    await vi.advanceTimersByTimeAsync(50);
    ptys[0]!.emitData("\u001b[2J\u001b[H■ Conversation interrupted\r\n› ");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(send).toHaveBeenCalledOnce();
    expect(await result).toBe("");
  } finally {
    vi.useRealTimers();
    await simple.close();
  }
});
