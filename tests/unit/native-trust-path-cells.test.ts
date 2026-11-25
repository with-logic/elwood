/** Native trust accepts row padding and rejects clipped terminal cell evidence (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import { onNativeRenderLost, settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { nativePathRowFits } from "../../src/terminal/snapshot.ts";

test("C-TRUST-01 native row evidence accounts for Codex-painted ASCII padding", async () => {
  const terminal = createHeadlessTerminal({ cols: 14, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput("  /tmp/a    \r\n  /tmp/long!");
    expect(nativePathRowFits(terminal.xterm, 0, 2, true)).toBe(true);
    expect(nativePathRowFits(terminal.xterm, 0, 0)).toBe(true);
    expect(nativePathRowFits(terminal.xterm, 1, 2)).toBe(false);
    expect(nativePathRowFits(terminal.xterm, 4, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 neither physical row of a wrapped target is complete", async () => {
  const terminal = createHeadlessTerminal({ cols: 8, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("/tmp/precisely");
    expect(nativePathRowFits(terminal.xterm, 0, 0)).toBe(false);
    expect(nativePathRowFits(terminal.xterm, 1, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 a wide final character cannot supply native row padding", async () => {
  const terminal = createHeadlessTerminal({ cols: 8, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("/tmp/a界");
    expect(nativePathRowFits(terminal.xterm, 0, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 subscribing after terminal disposal has no further events", () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 8 }, () => undefined);
  terminal.dispose();
  expect(settledNativeSnapshot(terminal)).toBeUndefined();
  const listener = vi.fn();
  const unsubscribe = onNativeRenderLost(terminal, listener);
  unsubscribe();
  expect(listener).not.toHaveBeenCalled();
});
