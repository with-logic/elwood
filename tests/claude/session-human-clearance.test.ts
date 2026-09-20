/** Claude human trust replacement holds queued input until native clearance (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTrust, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 Claude human trust holds caller input through a partial replacement", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys[0]!;
  const startup: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt") startup.push(event.kind);
  });
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
    expect(pty.writes).toEqual([]);
    expect(startup).toEqual([]);
    await session.sendKeys("\u001b");
    expect(pty.writes).toContain("\u001b");
    pty.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(
      session
        .statusDecisions()
        .filter((decision) => decision.evidence === "blocking_prompt_cleared"),
    ).toHaveLength(1);
    expect(pty.writes.filter((input) => input === callerText)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-TRUST-01 Claude cannot clear human trust from the prefix of one oversized receipt", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys[0]!;
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("after complete render");
    void queued.catch(() => undefined);
    pty.emitData(tty(`${claudeTrust}\n❯ 1. Yes, I trust this folder\n  2. No, exit`));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(session.status).toBe("blocked");
    const before = session.statusDecisions().length;
    const prefix = `\u001b[2J\u001b[H${claudeTty(claudeComposer)}`;
    pty.emitData(
      `${prefix}${"\0".repeat(65_536)}\u001b[2J\u001b[HUnknown permission\r\n❯ Continue`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      session
        .statusDecisions()
        .slice(before)
        .some((decision) => decision.to === "ready"),
    ).toBe(false);
    expect(pty.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
    pty.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(pty.writes).toEqual(["\u001b[200~after complete render\u001b[201~", "\r"]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-TRUST-01 Claude retains human trust after a render failure even if a later composer paints", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys[0]!;
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("held after failure");
    void queued.catch(() => undefined);
    pty.emitData(tty(`${claudeTrust}\n❯ 1. Yes, I trust this folder\n  2. No, exit`));
    await vi.advanceTimersByTimeAsync(11_000);
    vi.spyOn(session.terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    pty.emitData("replacement");
    await vi.advanceTimersByTimeAsync(10);
    pty.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.terminal.renderFailed).toBe(true);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await session.teardown();
  }
});
