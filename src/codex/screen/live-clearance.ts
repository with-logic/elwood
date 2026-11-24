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
    const frame = currentRenderedFrame(terminal, "live");
    // Native input follows the two-cell "› " or "» " prefix (zero-based column 2).
    if (
      frame === undefined ||
      !settledCursorVisible(terminal.xterm) ||
      frame.text !== text ||
      frame.cursorX !== 2
    )
      return false;
    // The cursor and snapshot rows both start at the live buffer's base.
    if (frame !== previous) {
      classification = codexComposerRowsClearance(frame.lines, {
        cursorRow: frame.cursorY,
        cols: frame.cols,
      });
      previous = frame;
    }
    return classification;
  };
}
