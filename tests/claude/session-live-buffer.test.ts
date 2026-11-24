/** Native composer proof follows the live buffer even while history is visible (C-ATTN-03). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { currentRenderedFrame, renderedSnapshot } from "../../src/terminal/cursor.ts";
import { claudeComposer, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
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
    const { isScrolled, paint } = await viewTerminalHistory(terminal, pty);
    await paint(
      tty(
        "────────────────\n Bash command\n ╌╌╌╌\n echo fixture\n ╌╌╌╌\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel",
      ),
    );
    expect(isScrolled()).toBe(true);
    expect(session.status).toBe("blocked");
    expect(terminal.snapshot().text).toContain("Historical output");
    expect(currentRenderedFrame(terminal, "live")).toBe(renderedSnapshot(terminal, "live"));
    let readyWhileScrolled = false;
    session.on("status", ({ status }) => {
      if (status === "ready") readyWhileScrolled = isScrolled();
    });
    vi.useFakeTimers();
    const sent = session.sendMessage("safe fixture input");
    void sent.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(250);
    expect(pty.writes).toEqual([]);
    const cleared = paint(claudeTty(claudeComposer));
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
