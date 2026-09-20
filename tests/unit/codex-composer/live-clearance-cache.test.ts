/** Cached row classification never substitutes for live render evidence (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import * as clearance from "../../../src/codex/screen/clearance.ts";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { currentRenderedFrame } from "../../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

test("C-TRUST-01 retries classify one unchanged snapshot once and recheck live title", async () => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const classify = vi.spyOn(clearance, "codexComposerRowsClearance");
  const title = vi.spyOn(terminal, "title", "get");
  try {
    await terminal.writeOutput(codexTty(codexSmallComposer));
    const clear = liveCodexClearance(() => terminal);
    const frame = currentRenderedFrame(terminal)!;
    for (let retry = 0; retry < 250; retry += 1) expect(clear(frame.text)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
    title.mockReturnValue("⠋ Working");
    expect(currentRenderedFrame(terminal)).toBe(frame);
    expect(clear(frame.text)).toBe(false);
    title.mockReturnValue("idle");
    expect(clear("an earlier frame")).toBe(false);
    expect(clear(frame.text)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
    await terminal.writeOutput("\u001b[Hupdated transcript\u001b[4;3H");
    expect(clear(terminal.snapshot().text)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(2);
  } finally {
    title.mockRestore();
    classify.mockRestore();
    terminal.dispose();
  }
});

test("C-TRUST-01 cached clearance cannot survive staged, hidden, synchronized, or failed renders", async () => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const clear = liveCodexClearance(() => terminal);
  const paint = `\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`;
  try {
    await terminal.writeOutput(paint);
    const text = terminal.snapshot().text;
    expect(clear(text)).toBe(true);
    const pending = terminal.writeOutput("\u001b[?25l");
    expect(clear(text)).toBe(false);
    await pending;
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput(paint);
    expect(clear(terminal.snapshot().text)).toBe(true);
    await terminal.writeOutput("\u001b[?2026h");
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput("\u001b[?2026l");
    expect(clear(terminal.snapshot().text)).toBe(true);
    await terminal.writeOutput("\u001b[4G");
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput(paint);
    expect(clear(terminal.snapshot().text)).toBe(true);
    vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("parser failed");
    });
    await expect(terminal.writeOutput("replacement")).rejects.toThrow("parser failed");
    expect(clear(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
