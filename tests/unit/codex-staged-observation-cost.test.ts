/** Native whitespace recovery shares one frame classification with normal draft recognition (C-API-31). */
import { expect, test, vi } from "vitest";
import { createCodexRecoveryComposer } from "../../src/codex/screen/staged-input.ts";
import * as facts from "../../src/core/screen-facts.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";

test("C-API-31 each captured whitespace recovery observation classifies the viewport once", async () => {
  const frame = readNativeInputFrame(
    new URL("../fixtures/codex-0.159.2/whitespace-only-input.json", import.meta.url),
  );
  const terminal = createHeadlessTerminal({ cols: frame.cols, rows: frame.rows }, () => undefined);
  try {
    expect(frame.baseY).toBe(0);
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${frame.text.replaceAll("\n", "\r\n")}\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25h\u001b]0;${frame.title}\u0007`,
    );
    const classify = vi.spyOn(facts, "readScreenFacts");
    const staged = createCodexRecoveryComposer(terminal).prepareStaged("  \t ");
    expect(staged()).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(staged()).toBe(true);
    expect(classify).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    terminal.dispose();
  }
});
