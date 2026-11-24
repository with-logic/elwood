/** Claude reports native cursor evidence from one settled live frame (C-TRUST-01). */
import { expect, test } from "vitest";
import { readClaudeInputCursor } from "../../src/claude/composer/cursor.ts";
import { settledLiveSnapshot } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test.each([
  ["hardware", 30, "❯ \x1b[3G\x1b[?25h", "hardware"],
  ["drawn", 30, "\x1b[?25l❯ \x1b[7m \x1b[27m\x1b[3G", "software"],
  ["hidden plain", 30, "\x1b[?25l❯  \x1b[3G", undefined],
  ["drawn off-column", 30, "\x1b[?25l❯  \x1b[7m \x1b[27m\x1b[4G", undefined],
  ["pending wrap", 2, "\x1b[?25l❯\u00a0", undefined],
] as const)("C-TRUST-01 %s Claude cursor evidence", async (_name, cols, paint, expected) => {
  const terminal = createHeadlessTerminal({ cols, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput(paint);
    const evidence = readClaudeInputCursor(terminal);
    if (expected) {
      expect(evidence?.kind).toBe(expected);
      expect(evidence?.frame).toBe(settledLiveSnapshot(terminal));
    } else {
      expect(evidence).toBeUndefined();
    }
  } finally {
    terminal.dispose();
  }
});
