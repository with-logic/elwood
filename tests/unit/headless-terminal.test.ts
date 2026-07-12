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

  test("input promises settle with PTY forwarding and disposal", async () => {
    const inputs: Array<string | Uint8Array> = [];
    const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, (input) => inputs.push(input));
    await terminal.sendInput("x");
    await terminal.sendInput(new Uint8Array([121]));
    expect(inputs).toEqual(["x", new Uint8Array([121])]);
    await terminal.sendInput("pending");
    terminal.dispose();
    await expect(terminal.sendInput("late")).rejects.toThrow("Terminal is disposed");
  });

  test("input promises reject PTY forwarding failures", async () => {
    const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, () => {
      throw new Error("PTY closed");
    });
    await expect(terminal.sendInput("x")).rejects.toThrow("PTY closed");
    await expect(terminal.sendInput(new Uint8Array([121]))).rejects.toThrow("PTY closed");
  });

  test("unsolicited xterm protocol replies are forwarded best-effort", async () => {
    const inputs: Array<string | Uint8Array> = [];
    const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, (input) => inputs.push(input));
    await terminal.writeOutput("\u001b[c");
    expect(inputs).toHaveLength(1);
    const failing = createHeadlessTerminal({ cols: 20, rows: 3 }, () => {
      throw new Error("PTY closed");
    });
    await expect(failing.writeOutput("\u001b[c")).resolves.toBeUndefined();
  });
});
