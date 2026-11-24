/** Select history while fake PTY frames continue to paint live (PRD §5.3). */
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";
import type { FakePty } from "./fake-pty.ts";

export async function viewTerminalHistory(
  terminal: ElwoodTerminal,
  pty: FakePty,
  firstScreen = "",
) {
  const isScrolled = () =>
    terminal.xterm.buffer.active.viewportY < terminal.xterm.buffer.active.baseY;
  pty.emitData(firstScreen + "Historical output\r\n".repeat(terminal.size.rows * 3 + 8));
  await terminal.settled();
  terminal.xterm.scrollToTop();
  return {
    isScrolled,
    async paint(data: string) {
      pty.emitData(`\u001b[2J\u001b[H${data}`);
      await terminal.settled();
    },
  };
}
