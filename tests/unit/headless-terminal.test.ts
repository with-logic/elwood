/**
 * Unit coverage for headless terminal snapshot padding and disposal guards.
 * Covers PRD §4.1, §5.3, and C-API-15.
 */

import { describe, expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { attachPtyTerminal, createHeadlessTerminal } from "../../src/terminal/headless.ts";

/** A minimal fake PTY that lets a test push data into the render pipeline. */
function fakePty(): {
  pty: PtyProcess;
  emit: (data: string) => void;
  writes: Array<string | Uint8Array>;
} {
  let handler: (data: string) => void = () => undefined;
  const writes: Array<string | Uint8Array> = [];
  const pty: PtyProcess = {
    pid: 1,
    onData: (h) => {
      handler = h;
      return () => undefined;
    },
    onExit: () => () => undefined,
    write: (data) => writes.push(data),
    resize: () => "resized",
    kill: () => undefined,
  };
  return { pty, emit: (data) => handler(data), writes };
}

describe("headless terminal", () => {
  test("C-API-15 snapshots pad missing buffer lines and ignore writes after dispose", async () => {
    const terminal = createHeadlessTerminal({ cols: 10, rows: 5 }, () => undefined);
    await terminal.writeOutput("hello");
    terminal.resize({ cols: 12, rows: 5 });
    expect(terminal.size).toEqual({ cols: 12, rows: 5 });
    terminal.xterm.resize(10, 2);
    const snapshot = terminal.snapshot();
    expect(snapshot.lines).toHaveLength(5);
    expect(snapshot.lines.slice(2)).toEqual(["", "", ""]);
    terminal.dispose();
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
  test("attachPtyTerminal swallows a throwing render continuation (no unhandled rejection)", async () => {
    const { pty, emit, writes } = fakePty();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // A throwing onRendered listener must not surface as an unhandled rejection on
      // normal PTY output — the render continuation's terminal catch owns it.
      const onRendered = vi.fn(() => {
        throw new Error("listener boom");
      });
      const terminal = attachPtyTerminal({ cols: 10, rows: 3 }, pty, onRendered);
      emit("hello");
      await terminal.settled();
      await new Promise((resolve) => setTimeout(resolve, 0)); // flush the .catch microtask
      expect(onRendered).toHaveBeenCalledTimes(1);
      expect(rejections).toEqual([]); // the catch swallowed the throw
      // Input written to the attached terminal forwards to the wrapped PTY.
      await terminal.sendInput("k");
      expect(writes).toContain("k");
      terminal.dispose();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a failed write does not poison subsequent writes", async () => {
    const terminal = createHeadlessTerminal({ cols: 10, rows: 3 }, () => undefined);
    // Force the underlying xterm.write to throw ONCE: the returned promise rejects,
    // but the write queue's never-rejecting tail must keep the next write healthy.
    const spy = vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("xterm boom");
    });
    await expect(terminal.writeOutput("boom")).rejects.toThrow("xterm boom");
    spy.mockRestore();
    // The chain was not left permanently rejected: a following write resolves.
    await expect(terminal.writeOutput("ok")).resolves.toBeUndefined();
    terminal.dispose();
  });
});
