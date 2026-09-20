/** Actual Codex renderer envelopes exclude stale-cursor partial dialogs (C-TRUST-01). */
import { expect, test } from "vitest";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { nativeDialogs } from "../../fixtures/codex-native-dialog-renders.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

test.each(
  nativeDialogs,
)("C-TRUST-01 captured $version $gate redraw cannot inherit a visible composer", async ({
  paint,
}) => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const clear = liveCodexClearance(() => terminal);
  const read = () => clear(terminal.snapshot().text);
  try {
    await terminal.writeOutput(codexTty(codexSmallComposer));
    expect(read()).toBe(true);
    // The first native control arrives while all old text/cursor state still exists.
    await terminal.writeOutput("\u001b[?2026h");
    expect(read()).toBe(false);
    await terminal.writeOutput(paint);
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[?25l");
    expect(read()).toBe(false);
    await terminal.writeOutput("\u001b[?2026l");
    expect(read()).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 an exact-shaped working quotation stays conservatively held even beside an editable composer", async () => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  try {
    await terminal.writeOutput(
      codexTty(`• Thinking (3s • esc to interrupt)\n${codexSmallComposer}`),
    );
    expect(liveCodexClearance(() => terminal)(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
