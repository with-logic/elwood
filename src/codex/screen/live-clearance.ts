/** Live native cursor, text, and title prove Codex trust clearance (C-TRUST-01). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexComposerClearance } from "./clearance.ts";
import { codexWorkingTitle } from "./working.ts";

/** All reads are synchronous and require the latest received render to be complete. */
export function liveCodexClearance(readTerminal: () => ElwoodTerminal): TrustClearance {
  return (text) => {
    const terminal = readTerminal();
    if (terminal.renderFailed || !settledCursorVisible(terminal.xterm)) return false;
    const frame = terminal.snapshot();
    if (frame.text !== text || frame.cursorX !== 2 || codexWorkingTitle.test(terminal.title))
      return false;
    const buffer = terminal.xterm.buffer.active;
    const row = frame.cursorY + buffer.baseY - buffer.viewportY;
    return codexComposerClearance(text, row);
  };
}
