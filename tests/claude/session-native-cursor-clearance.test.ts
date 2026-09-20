/** Native Claude classic-renderer completion owns human clearance (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeNativeIdlePaint, claudeNativeTrust } from "../fixtures/claude-cursor-278.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 captured Claude composer paint cannot clear human trust before native cursor restoration", async () => {
  installFakes();
  const session = await startClaude({
    cwd: tempDir(),
    autotrust: false,
    initialSize: { cols: 173, rows: 35 },
  });
  try {
    vi.useFakeTimers();
    const pty = ptys[0]!;
    pty.emitData(`\u001b[2J\u001b[H\u001b[?25l${claudeNativeTrust}`);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(session.status).toBe("blocked");
    const pending = session.sendMessage("after native cursor");
    void pending.catch(() => undefined);
    // An admissible PTY split immediately before the captured trailing DEC25h.
    pty.emitData(`\u001b[2J\u001b[H${claudeNativeIdlePaint}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.terminal.snapshot().text).toContain('Try "fix lint errors"');
    expect(pty.writes).toEqual([]);
    expect(session.status).toBe("blocked");
    pty.emitData("\u001b[?25h");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(pty.writes).toEqual(["\u001b[200~after native cursor\u001b[201~", "\r"]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
