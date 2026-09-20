/** Native Claude cursor placement distinguishes its completed input surface (C-TRUST-01). */
import { expect, test } from "vitest";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeNativeIdlePaint } from "../fixtures/claude-cursor-278.ts";

test("C-TRUST-01 live Claude clearance requires the current visible cursor on its composer", async () => {
  const terminal = createHeadlessTerminal({ cols: 173, rows: 35 }, () => undefined);
  const clear = liveClaudeClearance(() => terminal);
  const read = () => clear(terminal.snapshot().text);
  try {
    expect(read()).toBe(false);
    await terminal.writeOutput(`\u001b[?25l${claudeNativeIdlePaint}`);
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[?25h");
    expect(read()).toBe(true);
    expect(clear("stale frame")).toBe(false);
    await terminal.writeOutput("\u001b[4G");
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[1;3H");
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[1;1H❯ Continue\u001b[1;3H");
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[33;3H");
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[1;1H   ❯ \u001b[1;3H");
    expect(read()).toBe(false);
    await terminal.writeOutput(`\u001b[35;1H${"\r\n".repeat(40)}\u001b[3G`);
    terminal.xterm.scrollToTop();
    expect(read()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
