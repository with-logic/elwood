/** The live screen as text, read from the headless terminal (PRD §5.14, C-SCREEN-01 to 03). */
import { expect, test, vi } from "vitest";
import { createHeadlessTerminal, type ElwoodTerminal } from "../../src/terminal/headless.ts";
import {
  type ElwoodScreen,
  type ReadScreenOptions,
  readTerminalScreen,
} from "../../src/terminal/screen.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

const ESC = String.fromCharCode(27);
const numbered = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\r\n");
const firstSix = ["row 0", "row 1", "row 2", "row 3", "row 4", "row 5"];

/** A read from a terminal that has not been disposed, so it always has a screen. */
async function read(terminal: ElwoodTerminal, options?: ReadScreenOptions): Promise<ElwoodScreen> {
  const screen = await readTerminalScreen(terminal, options);
  if (screen === undefined) throw new Error("The terminal was disposed.");
  return screen;
}

/** Four rows that hold `row 6` to `row 9`, with `row 0` to `row 5` in scrollback. */
async function terminalWithScrollback() {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  await terminal.writeOutput(numbered);
  return terminal;
}

test("C-SCREEN-01 a read waits for PTY output that is still staged", async () => {
  const { terminal, emit } = setupTerminalPty();
  try {
    emit("first\r\nsecond");
    expect(terminal.snapshot().lines).toEqual(["", "", "", "", ""]);
    expect(await read(terminal)).toEqual({
      cols: 40,
      rows: 5,
      lines: ["first", "second", "", "", ""],
      scrollback: [],
      cursor: { x: 6, y: 1, visible: true },
      buffer: "normal",
      outputLost: false,
    });
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-01 the cursor counts cells and follows the cursor mode", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput(`你好${ESC}[?25l`);
    const wide = await read(terminal);
    expect(wide.lines[0]).toBe("你好");
    expect(wide.cursor).toEqual({ x: 4, y: 0, visible: false });
    await terminal.writeOutput(`${ESC}[?25h\r123456789012`);
    expect((await read(terminal)).cursor).toEqual({ x: 12, y: 0, visible: true });
    await terminal.writeOutput("abc");
    const wrapped = await read(terminal);
    expect(wrapped.lines).toEqual(["123456789012", "abc", ""]);
    expect(wrapped.cursor).toEqual({ x: 3, y: 1, visible: true });
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-01 a read does not wait for a synchronized repaint, and visibility follows DECTCEM only", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput(`partial${ESC}[?25h${ESC}[?2026h`);
    expect(terminal.xterm.modes.synchronizedOutputMode).toBe(true);
    expect(await read(terminal)).toMatchObject({
      lines: ["partial", "", ""],
      cursor: { visible: true },
    });
    await terminal.writeOutput(`${ESC}[?25l`);
    expect((await read(terminal)).cursor.visible).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-03 a disposed terminal has no screen, even for a read that was waiting", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  await terminal.writeOutput("drawn");
  void terminal.writeOutput("\r\nqueued");
  const waiting = readTerminalScreen(terminal);
  terminal.dispose();
  expect(await waiting).toBeUndefined();
  expect(await readTerminalScreen(terminal)).toBeUndefined();
});

test("C-SCREEN-01 a failed render marks every later read as having lost output", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 3 }, () => undefined);
  try {
    vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("xterm boom");
    });
    await expect(terminal.writeOutput("lost")).rejects.toThrow("xterm boom");
    await terminal.writeOutput("kept");
    expect(await read(terminal)).toMatchObject({
      lines: ["kept", "", ""],
      outputLost: true,
    });
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-02 scrollback is opt-in, oldest first, and capped by the request", async () => {
  const terminal = await terminalWithScrollback();
  const scrollback = async (option?: boolean | number) =>
    (await read(terminal, option === undefined ? {} : { scrollback: option })).scrollback;
  try {
    expect(await scrollback()).toEqual([]);
    expect(await scrollback(false)).toEqual([]);
    expect(await scrollback(0)).toEqual([]);
    expect(await scrollback(2)).toEqual(["row 4", "row 5"]);
    expect(await scrollback(50)).toEqual(firstSix);
    expect(await scrollback(true)).toEqual(firstSix);
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-02 the alternate screen has no scrollback while the normal buffer keeps its own", async () => {
  const terminal = await terminalWithScrollback();
  try {
    await terminal.writeOutput(`${ESC}[?1049h${ESC}[2;1Hfull screen`);
    expect(await read(terminal, { scrollback: true })).toMatchObject({
      lines: ["", "full screen", "", ""],
      scrollback: [],
      cursor: { x: 11, y: 1 },
      buffer: "alternate",
    });
    await terminal.writeOutput(`${ESC}[?1049l`);
    expect(await read(terminal, { scrollback: true })).toMatchObject({
      scrollback: firstSix,
      buffer: "normal",
    });
  } finally {
    terminal.dispose();
  }
});

test("C-SCREEN-02 the emulator's own limit bounds scrollback", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  try {
    terminal.xterm.options.scrollback = 3;
    await terminal.writeOutput(numbered);
    const screen = await read(terminal, { scrollback: true });
    expect(screen.scrollback).toEqual(["row 3", "row 4", "row 5"]);
    expect(screen.lines).toEqual(["row 6", "row 7", "row 8", "row 9"]);
  } finally {
    terminal.dispose();
  }
});

test.each([
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
])("C-SCREEN-02 scrollback %s rejects before anything is read", async (scrollback) => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 3 }, () => undefined);
  const settled = vi.spyOn(terminal, "settled");
  try {
    await expect(readTerminalScreen(terminal, { scrollback })).rejects.toThrow(TypeError);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
  }
});
