/** Current frame evidence is shared and cached only across unchanged renders (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import { currentRenderedFrame, renderedSnapshot } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-TRUST-01 current frame reuses a completed snapshot and invalidates on output and resize", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  const capture = vi.spyOn(terminal, "snapshot");
  try {
    expect(currentRenderedFrame(terminal)).toBeUndefined();
    await terminal.writeOutput("first");
    const first = renderedSnapshot(terminal);
    expect(currentRenderedFrame(terminal)).toBe(first);
    expect(renderedSnapshot(terminal)).toBe(first);
    expect(capture).toHaveBeenCalledTimes(1);
    const pending = terminal.writeOutput(" second");
    expect(currentRenderedFrame(terminal)).toBeUndefined();
    await pending;
    const second = currentRenderedFrame(terminal);
    expect(second?.text).toContain("first second");
    expect(second).not.toBe(first);
    terminal.resize({ cols: 30, rows: 5 });
    const resized = currentRenderedFrame(terminal);
    expect(resized?.cols).toBe(30);
    expect(resized?.rows).toBe(5);
    expect(resized).not.toBe(second);
    await terminal.writeOutput("\u001b[?2026h");
    expect(currentRenderedFrame(terminal)).toBeUndefined();
    await terminal.writeOutput("\u001b[?2026l");
    expect(currentRenderedFrame(terminal)).toBeDefined();
    vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    await expect(terminal.writeOutput("failed")).rejects.toThrow("render failed");
    expect(currentRenderedFrame(terminal)).toBeUndefined();
  } finally {
    terminal.dispose();
  }
  expect(currentRenderedFrame(terminal)).toBeUndefined();
  const snapshot = { cols: 1, rows: 1, cursorX: 0, cursorY: 0, lines: [""], text: "" };
  capture.mockReturnValue(snapshot);
  expect(renderedSnapshot(terminal)).toBe(snapshot);
});
