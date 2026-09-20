/** Live native cursor, text, and title prove Codex trust clearance (C-TRUST-01). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { codexComposerRowsClearance } from "./clearance.ts";
import { codexWorkingTitle } from "./working.ts";

/** All reads are synchronous and require the latest received render to be complete. */
export function liveCodexClearance(readTerminal: () => ElwoodTerminal): TrustClearance {
  let previous: TerminalSnapshot | undefined;
  let classification = false;
  return (text) => {
    const terminal = readTerminal();
    if (codexWorkingTitle.test(terminal.title)) return false;
    const frame = currentRenderedFrame(terminal);
    // Native input follows the two-cell "› " prefix (zero-based column 2).
    if (
      frame === undefined ||
      !settledCursorVisible(terminal.xterm) ||
      frame.text !== text ||
      frame.cursorX !== 2
    )
      return false;
    const buffer = terminal.xterm.buffer.active;
    // cursorY is relative to the active buffer base; snapshot rows start at viewportY.
    // Example: cursorY=3, baseY=10, viewportY=8 identifies snapshot row 5.
    const viewportCursorRow = frame.cursorY + buffer.baseY - buffer.viewportY;
    // RenderCursor replaces this private snapshot on a render or viewport change.
    // Live evidence above is rechecked even when its row classification is reusable.
    if (frame !== previous) {
      classification = codexComposerRowsClearance(frame.lines, viewportCursorRow);
      previous = frame;
    }
    return classification;
  };
}
