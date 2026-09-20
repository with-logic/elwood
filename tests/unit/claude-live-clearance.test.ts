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

test("C-TRUST-01 a title-only working update vetoes the unchanged visible Claude composer", async () => {
  const terminal = createHeadlessTerminal({ cols: 173, rows: 35 }, () => undefined);
  const clear = liveClaudeClearance(() => terminal);
  try {
    await terminal.writeOutput(`${claudeNativeIdlePaint}\u001b[?25h`);
    const idle = terminal.snapshot();
    expect(clear(idle.text)).toBe(true);
    await terminal.writeOutput("\u001b]0;⠋ Working\u0007");
    expect(terminal.snapshot()).toEqual(idle);
    expect(terminal.title).toBe("⠋ Working");
    expect(clear(idle.text)).toBe(false);
    await terminal.writeOutput("\u001b]0;✳ Ready\u0007");
    expect(terminal.snapshot()).toEqual(idle);
    expect(clear(idle.text)).toBe(true);
  } finally {
    terminal.dispose();
  }
});
