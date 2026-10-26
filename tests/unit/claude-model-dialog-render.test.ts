/** Captured Claude model repaint cannot inherit a visible composer (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import { claudeTrustClearance, liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeNativeIdlePaint } from "../fixtures/claude-cursor-278.ts";
import { claudeModelDialogRender } from "../fixtures/claude-model-dialog-render.ts";

test("C-TRUST-01 captured Claude 2.1.278 model paint stays held after native cursor hiding", async () => {
  const terminal = createHeadlessTerminal({ cols: 173, rows: 35 }, () => undefined);
  const clear = liveClaudeClearance(() => terminal);
  const read = () => clear(terminal.snapshot().text);
  const hide = "\u001b[?25l";
  // xterm parses each write on its own timer. Firing it at once still renders every
  // prefix, minus 1,241 real timer waits that a loaded machine stretches past the timeout.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const write = async (data: string) => {
    const written = terminal.writeOutput(data);
    vi.runAllTimers();
    await written;
  };
  try {
    await write(`${claudeNativeIdlePaint}\u001b[?25h`);
    expect(read()).toBe(true);
    expect(claudeModelDialogRender.startsWith(hide)).toBe(true);
    // Establish the complete captured DEC25l before splitting the remaining paint.
    // A byte prefix inside DEC25l has not yet told the terminal to hide its cursor.
    await write(hide);
    expect(read()).toBe(false);
    let prefixes = 0;
    let textOnlyClearPrefixes = 0;
    for (const character of claudeModelDialogRender.slice(hide.length)) {
      await write(character);
      prefixes++;
      expect(read(), `native model paint prefix ${prefixes}`).toBe(false);
      if (claudeTrustClearance(terminal.snapshot().text)) textOnlyClearPrefixes++;
    }
    expect(prefixes).toBe(1241);
    // Stale composer chrome survives some actual prefixes; the cursor guard matters.
    expect(textOnlyClearPrefixes).toBeGreaterThan(0);
    expect(terminal.snapshot().text).toContain("Select model");
    expect(terminal.snapshot().text).toContain("Esc to cancel");
    expect(terminal.snapshot().cursorX).toBe(3);
    expect(terminal.snapshot().cursorY).toBe(27);
    expect(read()).toBe(false);
  } finally {
    vi.useRealTimers();
    terminal.dispose();
  }
});
