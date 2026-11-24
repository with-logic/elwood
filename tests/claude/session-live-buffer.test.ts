/** Native composer proof follows the live buffer even while history is visible (C-ATTN-03). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { currentRenderedFrame, renderedSnapshot } from "../../src/terminal/cursor.ts";
import { claudeComposer, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { ready } from "./login-helpers.ts";

afterEach(resetFakes);

test("C-ATTN-03 Claude sees approval and idle clearance in the live buffer while viewing history", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const terminal = session.terminal;
  const pty = ptys[0]!;
  try {
    await ready(cwd, session);
    pty.emitData("Historical output\r\n".repeat(terminal.size.rows * 3 + 8));
    await terminal.settled();
    terminal.xterm.scrollToTop();
    const paint = async (data: string) => {
      pty.emitData(`\u001b[2J\u001b[H${data}`);
      await terminal.settled();
    };
    await paint(
      tty(
        "────────────────\n Bash command\n ╌╌╌╌\n echo fixture\n ╌╌╌╌\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel",
      ),
    );
    expect(session.status).toBe("blocked");
    expect(terminal.snapshot().text).toContain("Historical output");
    expect(currentRenderedFrame(terminal, "live")).toBe(renderedSnapshot(terminal, "live"));
    await paint(claudeTty(claudeComposer));
    expect(session.status).toBe("ready");
    expect(terminal.xterm.buffer.active.viewportY).toBeLessThan(terminal.xterm.buffer.active.baseY);
    expect(pty.writes).toEqual([]);
  } finally {
    await session.stop();
  }
});
