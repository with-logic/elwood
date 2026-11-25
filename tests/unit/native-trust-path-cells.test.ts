/** Native trust accepts row padding and rejects clipped terminal cell evidence (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import {
  onNativeRenderEvidenceInvalidated,
  settledNativeSnapshot,
} from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { hasUnwrappedRowEndPadding } from "../../src/terminal/snapshot.ts";

test("C-TRUST-01 native row evidence accounts for Codex-painted ASCII padding", async () => {
  const terminal = createHeadlessTerminal({ cols: 14, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput("  /tmp/a    \r\n  /tmp/long!");
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 2, true)).toBe(true);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 2)).toBe(false);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 0)).toBe(true);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 1, 2)).toBe(false);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 4, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 neither physical row of a wrapped target is complete", async () => {
  const terminal = createHeadlessTerminal({ cols: 8, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("/tmp/precisely\x1b[1;7H\x1b[K");
    expect(terminal.xterm.buffer.active.getLine(0)?.getCell(6)?.getChars()).toBe("");
    expect(terminal.xterm.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 0)).toBe(false);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 1, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 a wide final character cannot supply native row padding", async () => {
  const terminal = createHeadlessTerminal({ cols: 8, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("/tmp/界");
    const placeholder = terminal.xterm.buffer.active.getLine(0)?.getCell(6);
    expect(placeholder?.getWidth()).toBe(0);
    expect(placeholder?.getChars()).toBe("");
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 0)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 subscribing after terminal disposal has no further events", () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 8 }, () => undefined);
  terminal.dispose();
  expect(settledNativeSnapshot(terminal)).toBeUndefined();
  const listener = vi.fn();
  const unsubscribe = onNativeRenderEvidenceInvalidated(terminal, listener);
  unsubscribe();
  expect(listener).not.toHaveBeenCalled();
});

test("C-TRUST-01 row evidence is limited to integer rows in the live viewport", async () => {
  const terminal = createHeadlessTerminal({ cols: 14, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("scrollback\r\nfirst\r\nsecond\r\nlast");
    expect(terminal.xterm.buffer.active.baseY).toBe(1);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, -1, 0)).toBe(false);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0.5, 0)).toBe(false);
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 2, 0)).toBe(true);
  } finally {
    terminal.dispose();
  }
});
