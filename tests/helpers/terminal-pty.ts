/** Supply PTY bytes to the real terminal renderer in tests (PRD §13 test seams). */
import type { PtyProcess } from "../../src/pty/types.ts";
import { attachPtyTerminal, type ElwoodTerminal } from "../../src/terminal/headless.ts";

export function setupTerminalPty(
  onRendered: (data: string, terminal: ElwoodTerminal) => void = () => {},
) {
  let emit = (_data: string) => {};
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      emit = handler;
      return () => {};
    },
    onExit: () => () => {},
    write: () => {},
    resize: () => "resized",
    kill: () => {},
  };
  const terminal = attachPtyTerminal({ cols: 40, rows: 5 }, pty, onRendered);
  return { terminal, emit };
}
