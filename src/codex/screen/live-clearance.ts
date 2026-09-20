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
    if (
      terminal.renderFailed ||
      !settledCursorVisible(terminal.xterm) ||
      codexWorkingTitle.test(terminal.title)
    )
      return false;
    const frame = terminal.snapshot();
    // Native input follows the two-cell "› " prefix (zero-based column 2).
    if (frame.text !== text || frame.cursorX !== 2) return false;
    const buffer = terminal.xterm.buffer.active;
    // cursorY is relative to the active buffer base; snapshot rows start at viewportY.
    // Example: cursorY=3, baseY=10, viewportY=8 identifies snapshot row 5.
    const viewportCursorRow = frame.cursorY + buffer.baseY - buffer.viewportY;
    return codexComposerClearance(text, viewportCursorRow);
  };
}
