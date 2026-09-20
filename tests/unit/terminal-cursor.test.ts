/** Cursor provenance waits for raw PTY receipt and completed renders (C-TRUST-01). */
import { expect, test } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { settledCursorVisible } from "../../src/terminal/cursor.ts";
import { attachPtyTerminal, createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-TRUST-01 visibility follows parsed cursor modes, resets, and disposal", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  const visible = () => settledCursorVisible(terminal.xterm);
  try {
    expect(visible()).toBe(false);
    await terminal.writeOutput("\u001b[?25h");
    expect(visible()).toBe(true);
    const pending = terminal.writeOutput("\u001b[?25l");
    expect(visible()).toBe(false);
    await pending;
    expect(visible()).toBe(false);
    await terminal.writeOutput("\u001b[?2004h\u001b[?2004l");
    expect(visible()).toBe(false);
    await terminal.writeOutput("\u001b[!p");
    expect(visible()).toBe(true);
    await terminal.writeOutput("\u001b[?25l\u001bc");
    expect(visible()).toBe(true);
    await terminal.writeOutput("\u001b[?25;2026h");
    expect(visible()).toBe(false);
    await terminal.writeOutput("\u001b[?2026l");
    expect(visible()).toBe(true);
  } finally {
    terminal.dispose();
  }
  expect(visible()).toBe(false);
});

test("C-TRUST-01 staged PTY bytes invalidate cursor proof before batch rendering", async () => {
  let emit: (data: string) => void = () => undefined;
  const pty: PtyProcess = {
    pid: 1,
    onData(handler) {
      emit = handler;
      return () => undefined;
    },
    onExit: () => () => undefined,
    write() {},
    resize: () => "resized",
    kill() {},
  };
  const observations: boolean[] = [];
  const terminal = attachPtyTerminal({ cols: 20, rows: 4 }, pty, (_, current) => {
    observations.push(settledCursorVisible(current.xterm));
  });
  try {
    emit("\u001b[?25h");
    await terminal.settled();
    expect(observations).toEqual([true]);
    emit("");
    expect(settledCursorVisible(terminal.xterm)).toBe(true);
    emit("\u001b[?25l");
    expect(settledCursorVisible(terminal.xterm)).toBe(false);
    await terminal.settled();
    expect(observations).toEqual([true, false]);
    emit(`\u001b[?25h${" ".repeat(65_536)}`);
    emit("\u001b[?25l");
    await terminal.settled();
    expect(observations.slice(2).length).toBeGreaterThan(1);
    expect(observations.slice(2).every((visible) => !visible)).toBe(true);
    const first = terminal.writeOutput("\u001b[?25h");
    const later = terminal.writeOutput("\u001b[?25l");
    await Promise.all([first, later]);
    expect(settledCursorVisible(terminal.xterm)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
