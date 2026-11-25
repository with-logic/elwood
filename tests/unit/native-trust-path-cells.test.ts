/** Native trust accepts row padding and rejects clipped terminal cell evidence (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import {
  onNativeRenderEvidenceInvalidated,
  settledNativeSnapshot,
} from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { hasUnwrappedRowEndPadding } from "../../src/terminal/snapshot.ts";

test("C-TRUST-01 synthetic ASCII spaces count as padding when explicitly allowed", async () => {
  const terminal = createHeadlessTerminal({ cols: 14, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput("  /tmp/a    \r\n  /tmp/long!");
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, {
        viewportRow: 0,
        rightInsetColumns: 2,
        allowAsciiPadding: true,
      }),
    ).toBe(true);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 0, rightInsetColumns: 2 }),
    ).toBe(false);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 0, rightInsetColumns: 0 }),
    ).toBe(true);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 1, rightInsetColumns: 2 }),
    ).toBe(false);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 4, rightInsetColumns: 0 }),
    ).toBe(false);
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
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 0, rightInsetColumns: 0 }),
    ).toBe(false);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 1, rightInsetColumns: 0 }),
    ).toBe(false);
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
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 0, rightInsetColumns: 0 }),
    ).toBe(false);
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
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: -1, rightInsetColumns: 0 }),
    ).toBe(false);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 0.5, rightInsetColumns: 0 }),
    ).toBe(false);
    expect(
      hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow: 2, rightInsetColumns: 0 }),
    ).toBe(true);
  } finally {
    terminal.dispose();
  }
});
