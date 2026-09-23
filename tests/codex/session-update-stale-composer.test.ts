/** Visible old composer chrome cannot release an update replacement (C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
test.each([
  [false, ""],
  [false, "\r\n❯ Proceed\r\n  Cancel"],
  [true, ""],
  [true, "\r\n❯ Proceed\r\n  Cancel"],
] as const)("C-CODEX-12 stale cursor holds replacement (resume=%s, options=%s)", async (resume, options) => {
  installFakes();
  const cwd = tempDir();
  let session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    if (resume) {
      await session.stop();
      session = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    }
    vi.useFakeTimers();
    const pty = ptys.at(-1)!;
    pty.emitData(
      `\u001b[2J\u001b[H${codexTty(`\n\n\n\n\n${codexSmallComposer}`)}` +
        "\u001b7\u001b[HUpdate available! 0.151.0 -> 0.152.0\u001b8",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(session.status).toBe("blocked");
    const sent = session.sendMessage("after the dialog");
    void sent.catch(() => undefined);
    pty.emitData(`\u001b7\u001b[H\u001b[2KConfirm archive removal?${options}\u001b8`);
    // Cross the queue debounce deterministically while only stale composer evidence exists.
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual([]);
    expect(session.status).toBe("blocked");
    pty.emitData("\u001b[2J\u001b[HRepainting choices…");
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.writes).toEqual([]);
    expect(session.status).toBe("blocked");
    pty.emitData(`\u001b[2J\u001b[H${codexTty(`Earlier conversation\n${codexSmallComposer}`)}`);
    await vi.advanceTimersByTimeAsync(500);
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~after the dialog\u001b[201~", "\r"]);
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
