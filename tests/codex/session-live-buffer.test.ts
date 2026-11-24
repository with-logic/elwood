/** Native input holds follow the live terminal buffer (PRD §5.3, C-ATTN-03). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-ATTN-03 live approval holds input and a composer releases it while history is visible", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const terminal = session.terminal;
  const pty = ptys[0]!;
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    const { isScrolled, paint } = await viewTerminalHistory(terminal, pty);
    await paint(
      tty(
        "Would you like to run the following command?\n $ echo fixture\n› 1. Yes (y)\n  2. No (esc)\nPress enter to confirm or esc to cancel",
      ),
    );
    expect(isScrolled()).toBe(true);
    expect(session.status).toBe("blocked");
    expect(terminal.snapshot().text).toContain("Historical output");
    let readyWhileScrolled = false;
    session.on("status", ({ status }) => {
      if (status === "ready") readyWhileScrolled = isScrolled();
    });
    vi.useFakeTimers();
    const sent = session.sendMessage("safe fixture input");
    void sent.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(250);
    expect(pty.writes).toEqual([]);
    const cleared = paint(codexTty(codexComposer));
    await vi.advanceTimersByTimeAsync(250);
    await cleared;
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~safe fixture input\u001b[201~", "\r"]);
    expect(readyWhileScrolled).toBe(true);
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
