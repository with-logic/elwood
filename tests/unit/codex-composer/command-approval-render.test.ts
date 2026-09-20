/** Actual command-permission paint cannot inherit composer cursor proof (C-TRUST-01). */
import { expect, test } from "vitest";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { codexCommandApprovalRender } from "../../fixtures/codex-command-approval-render.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

test("C-TRUST-01 every captured Codex 0.155.1 permission-paint prefix retains the hold", async () => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const clear = liveCodexClearance(() => terminal);
  const read = () => clear(terminal.snapshot().text);
  const begin = "\u001b[?2026h";
  const end = "\u001b[?2026l";
  try {
    expect(codexCommandApprovalRender.startsWith(begin)).toBe(true);
    expect(codexCommandApprovalRender.endsWith(`\u001b[?25l${end}`)).toBe(true);
    await terminal.writeOutput(codexTty(codexSmallComposer));
    expect(read()).toBe(true);
    await terminal.writeOutput(begin);
    expect(read()).toBe(false);
    const paint = codexCommandApprovalRender.slice(begin.length, -end.length);
    // Split even inside cursor controls and option text, where PTY receipts may end.
    for (const character of paint) {
      await terminal.writeOutput(character);
      expect(read()).toBe(false);
    }
    await terminal.writeOutput(end);
    expect(terminal.xterm.modes.synchronizedOutputMode).toBe(false);
    expect(terminal.snapshot().text).toContain("Would you like to run the following command?");
    expect(terminal.snapshot().text).toContain("› 1. Yes, proceed (y)");
    expect(read()).toBe(false);
    await terminal.writeOutput(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    expect(read()).toBe(true);
  } finally {
    terminal.dispose();
  }
});
