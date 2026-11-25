/** Claude's verified composer holding a staged draft is attention clearance (C-ATTN-09, PRD §5.3). */
import { expect, test } from "vitest";
import { claudeStagedComposerClearance } from "../../src/claude/composer/staged-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const closed = readNativeInputFrame(
  new URL("../fixtures/claude-2.1.332/offer-closed-staged.json", import.meta.url),
);
const pill = "❯ [Pasted text #1 +3 lines]";
/** The captured offer's rule, title, copy, menu and hint rows. */
const offerRows = capturedFrame("claude-2.1.332/auto-mode-offer").split("\n").slice(26, 36);

test("C-ATTN-09 only the live composer holding a staged draft clears", async () => {
  const terminal = createHeadlessTerminal({ cols: closed.cols, rows: closed.rows }, () => {});
  const clearance = claudeStagedComposerClearance(() => terminal);
  try {
    // Nothing painted: no composer cursor to read.
    expect(clearance(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput(nativeFrameOutput(closed));
    const live = terminal.snapshot().text;
    expect(live).toContain(pill);
    expect(clearance(live)).toBe(true);
    // A decision is about the live frame only, never an older or newer one.
    expect(clearance(`${live}\n`)).toBe(false);
    // The offer painted above the composer holding the draft is still a dialog.
    const rows = closed.text.split("\n");
    rows.splice(25, offerRows.length, ...offerRows);
    await terminal.writeOutput(nativeFrameOutput({ ...closed, text: rows.join("\n") }));
    expect(terminal.snapshot().text).toContain(pill);
    expect(clearance(terminal.snapshot().text)).toBe(false);
    // An empty composer is the idle path's evidence, not a staged draft.
    const empty = { ...closed, text: closed.text.replace(pill, "❯ "), cursorX: 2 };
    await terminal.writeOutput(nativeFrameOutput(empty));
    expect(clearance(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
