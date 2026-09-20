/** Partial and working frames retain trust-owned queued input (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  ["human gate partial replacement", false, tty("Unrecognized permission\n› Continue")],
  ["human gate title-only work", false, `\u001b]0;⠋ project\u0007${tty(codexComposer)}`],
  ["human gate bare caret", false, tty("› \n  gpt-5.5 high")],
] as const)("C-TRUST-01 %s keeps caller input held", async (_name, autotrust, repaint) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust });
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("after trust");
    ptys[0]!.emitData(tty(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`));
    await vi.advanceTimersByTimeAsync(6_000);
    const callerText = "\u001b[200~after trust\u001b[201~";
    expect(ptys[0]!.writes).not.toContain(callerText);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${repaint}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(ptys[0]!.writes).not.toContain(callerText);
    expect(session.status).toBe("blocked");
    await session.sendKeys("\u001b");
    expect(ptys[0]!.writes).toContain("\u001b");
    expect(ptys[0]!.writes).not.toContain(callerText);
    ptys[0]!.emitData(`\u001b]0;project\u0007\u001b[2J\u001b[H${tty(codexComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(ptys[0]!.writes.filter((input) => input === callerText)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
