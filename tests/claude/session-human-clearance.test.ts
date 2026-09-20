/** Claude human trust replacement holds queued input until native clearance (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 Claude human trust holds caller input through a partial replacement", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys[0]!;
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("after trust");
    pty.emitData(tty(`${claudeTrust}\n❯ 1. Yes, I trust this folder\n  2. No, exit`));
    await vi.advanceTimersByTimeAsync(6_000);
    const callerText = "\u001b[200~after trust\u001b[201~";
    expect(pty.writes).not.toContain(callerText);
    pty.emitData("\u001b[2J\u001b[HUnrecognized permission\r\n❯ Continue");
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).not.toContain(callerText);
    expect(session.status).toBe("blocked");
    await session.sendKeys("\u001b");
    expect(pty.writes).toContain("\u001b");
    pty.emitData(`\u001b[2J\u001b[H${tty(claudeComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(pty.writes.filter((input) => input === callerText)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
