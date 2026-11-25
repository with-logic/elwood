/** Verify that native snapshots depend on settled, unchanged PTY output. */
import { expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { onNativeRenderLost, settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";

function setup() {
  let emit: (output: string) => void = () => {};
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      emit = handler;
      return () => {};
    },
    onExit: () => () => {},
    write: () => {},
    resize: () => "resized",
    kill: () => {},
  };
  const terminal = attachPtyTerminal({ cols: 40, rows: 5 }, pty, () => {});
  return { terminal, emit: (text: string) => emit(text) };
}

test("proves native snapshots only after all output has rendered", async () => {
  const { terminal, emit } = setup();
  try {
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("native");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)?.text).toContain("native");
    emit("\x1b[?2026h still rendering");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("\x1b[?2026l");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)?.text).toContain("still rendering");
  } finally {
    terminal.dispose();
  }
});

test.each([
  "writeOutput",
  "clear",
  "reset",
] as const)("revokes native proof only once after host %s", async (operation) => {
  const { terminal, emit } = setup();
  const lost = vi.fn();
  const off = onNativeRenderLost(terminal, lost);
  try {
    emit("native");
    await terminal.settled();
    if (operation === "writeOutput") await terminal.writeOutput("host");
    else terminal.xterm[operation]();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("fresh native");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    expect(lost).toHaveBeenCalledTimes(1);
  } finally {
    off();
    terminal.dispose();
  }
});
