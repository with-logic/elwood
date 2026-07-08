/**
 * Unit coverage for headless terminal snapshot padding and disposal guards.
 * Covers PRD §4.1, §5.3, and C-API-15.
 */

import { describe, expect, test } from "vitest";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

describe("headless terminal", () => {
  test("C-API-15 snapshots pad missing buffer lines and ignore writes after dispose", async () => {
    const terminal = createHeadlessTerminal({ cols: 10, rows: 5 }, () => undefined);
    await terminal.writeOutput("hello");
    terminal.xterm.resize(10, 2);
    const snapshot = terminal.snapshot();
    expect(snapshot.lines).toHaveLength(5);
    expect(snapshot.lines.slice(2)).toEqual(["", "", ""]);
    terminal.dispose();
    await expect(terminal.writeOutput("after dispose")).resolves.toBeUndefined();
  });

  test("C-TURN-05 tracks the latest OSC window title", async () => {
    const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, () => undefined);
    expect(terminal.title).toBe("");
    // OSC 2 sets the window title, terminated by BEL.
    await terminal.writeOutput(`${String.fromCharCode(27)}]2;⠹ working${String.fromCharCode(7)}`);
    expect(terminal.title).toBe("⠹ working");
    await terminal.writeOutput(`${String.fromCharCode(27)}]2;✳ idle${String.fromCharCode(7)}`);
    expect(terminal.title).toBe("✳ idle");
  });
});
