/** The final screen stays readable from memory after disposal (PRD §5.14, C-SCREEN-03). */
import { expect, test, vi } from "vitest";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readTerminalScreen } from "../../src/terminal/screen.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

const numbered = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\r\n");

test("C-SCREEN-03 a disposed terminal returns its final screen with cursor and scrollback", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  await terminal.writeOutput(numbered);
  terminal.dispose();
  const final = await readTerminalScreen(terminal, { scrollback: 2 });
  expect(final).toEqual({
    cols: 12,
    rows: 4,
    lines: ["row 6", "row 7", "row 8", "row 9"],
    scrollback: ["row 4", "row 5"],
    cursor: { x: 5, y: 3, visible: true },
    buffer: "normal",
    outputLost: false,
  });
  const retained = ["row 0", "row 1", "row 2", "row 3", "row 4", "row 5"];
  const all = await readTerminalScreen(terminal, { scrollback: true });
  expect(all.scrollback).toEqual(retained);
  expect((await readTerminalScreen(terminal)).scrollback).toEqual([]);
  // Each read hands out its own copy of the final screen, so changing one changes no other.
  (all.scrollback as string[]).splice(0);
  expect((await readTerminalScreen(terminal, { scrollback: true })).scrollback).toEqual(retained);
  expect((await readTerminalScreen(terminal)).lines).not.toBe(final.lines);
  expect((await readTerminalScreen(terminal)).cursor).not.toBe(final.cursor);
});

test("C-SCREEN-03 a read that was waiting at disposal gets the final screen, marked lossy", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  await terminal.writeOutput("drawn");
  const queued = terminal.writeOutput("\r\nqueued");
  const waiting = readTerminalScreen(terminal);
  terminal.dispose();
  // Disposal releases the write it never drew.
  await expect(queued).resolves.toBeUndefined();
  expect(await waiting).toMatchObject({
    lines: ["drawn", "", "", ""],
    cursor: { visible: true },
    outputLost: true,
  });
});

test("C-SCREEN-03 PTY output still staged at disposal marks the final screen as lossy", async () => {
  const { terminal, emit } = setupTerminalPty();
  emit("never drawn");
  terminal.dispose();
  expect(await readTerminalScreen(terminal)).toMatchObject({
    lines: ["", "", "", "", ""],
    outputLost: true,
  });
});

test("C-SCREEN-03 a terminal disposed before any output keeps a blank final screen", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 4 }, () => undefined);
  terminal.dispose();
  expect(await readTerminalScreen(terminal, { scrollback: true })).toEqual({
    cols: 12,
    rows: 4,
    lines: ["", "", "", ""],
    scrollback: [],
    cursor: { x: 0, y: 0, visible: true },
    buffer: "normal",
    outputLost: false,
  });
});

test("C-SCREEN-03 disposal from a render observer keeps fully drawn output as not lost", async () => {
  const { terminal, emit } = setupTerminalPty((_data, rendered) => rendered.dispose());
  emit("drawn");
  expect(await readTerminalScreen(terminal)).toMatchObject({
    lines: ["drawn", "", "", "", ""],
    outputLost: false,
  });
});

test("C-SCREEN-03 a final screen keeps an earlier render failure as lost output", async () => {
  const terminal = createHeadlessTerminal({ cols: 12, rows: 3 }, () => undefined);
  vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("xterm boom");
  });
  await expect(terminal.writeOutput("lost")).rejects.toThrow("xterm boom");
  await terminal.writeOutput("kept");
  terminal.dispose();
  expect(await readTerminalScreen(terminal)).toMatchObject({
    lines: ["kept", "", ""],
    outputLost: true,
  });
});

test("C-SCREEN-03 disposal inside a PTY batch's render reports the chunk being staged as lost", async () => {
  const disposed = Promise.withResolvers<void>();
  const { terminal, emit } = setupTerminalPty((_data, rendered) => {
    rendered.dispose();
    disposed.resolve();
  });
  // xterm renders the first write after host input synchronously, inside the PTY push.
  await terminal.sendInput("x");
  emit("a".repeat(40_000));
  emit("b".repeat(40_000)); // past the batch size: push flushes the a's, then stages the b's
  await disposed.promise;
  expect(await readTerminalScreen(terminal)).toMatchObject({ outputLost: true });
});
