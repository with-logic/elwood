/** Native input holds follow the live terminal buffer (PRD §5.3, C-ATTN-03). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-ATTN-03 native approval and clearance hold queued input while history is visible", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const terminal = session.terminal;
  const pty = ptys[0]!;
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    pty.emitData("Historical output\r\n".repeat(terminal.size.rows * 3 + 8));
    await terminal.settled();
    terminal.xterm.scrollToTop();
    const isScrolled = () =>
      terminal.xterm.buffer.active.viewportY < terminal.xterm.buffer.active.baseY;
    const paint = async (data: string) => {
      pty.emitData(`\u001b[2J\u001b[H${data}`);
      await terminal.settled();
      expect(isScrolled()).toBe(true);
    };
    await paint(
      tty(
        "Would you like to run the following command?\n $ echo fixture\n› 1. Yes (y)\n  2. No (esc)\nPress enter to confirm or esc to cancel",
      ),
    );
    expect(session.status).toBe("blocked");
    expect(terminal.snapshot().text).toContain("Historical output");
    let readyWhileScrolled = false;
    session.on("status", ({ status }) => {
      if (status === "ready") readyWhileScrolled = isScrolled();
    });
    const sent = session.sendMessage("safe fixture input");
    void sent.catch(() => undefined);
    expect(pty.writes).toEqual([]);
    await paint(codexTty(codexComposer));
    await sent;
    expect(pty.writes).toContain("\r");
    expect(readyWhileScrolled).toBe(true);
  } finally {
    await session.stop();
  }
});
