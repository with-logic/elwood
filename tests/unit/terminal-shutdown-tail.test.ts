/**
 * Output received while the runtime drain is in progress is rendered, not discarded.
 * Drives the real renderer and the real drain over a live in-memory PTY (PRD §9.4, C-LIFE-12).
 */

import { afterEach, expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import {
  drainAndDisposeTerminal,
  terminalDrainTimeoutMs,
} from "../../src/runtime/shutdown/terminal.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";

afterEach(() => vi.useRealTimers());

function livePty() {
  const handlers = new Set<(data: string) => void>();
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onExit: () => () => undefined,
    write: () => undefined,
    resize: () => "resized",
    kill: () => undefined,
  };
  const emit = (data: string) => {
    for (const handler of [...handlers]) handler(data);
  };
  return { pty, emit, listeners: () => handlers.size };
}

test("C-LIFE-12 output received while earlier output drains is rendered before disposal", async () => {
  const { pty, emit, listeners } = livePty();
  const rendered: string[] = [];
  const terminal = attachPtyTerminal({ cols: 40, rows: 4 }, pty, (data) => rendered.push(data));
  emit("FIRST ");
  const drained = drainAndDisposeTerminal(terminal, pty);
  emit("SECOND "); // received while FIRST is still rendering
  await terminal.settled();
  emit("TAIL"); // received after a settle pass that itself saw new output
  await drained;
  expect(rendered.join("")).toBe("FIRST SECOND TAIL");
  expect(listeners()).toBe(0); // the drain's own PTY listener and the terminal's are released
});

test("C-LIFE-12 a PTY that never goes quiet is disposed when the single drain budget expires", async () => {
  vi.useFakeTimers();
  const { pty, emit } = livePty();
  const dispose = vi.fn();
  // Every settle pass takes 5 ms, and the PTY delivers more output during each one.
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const drained = drainAndDisposeTerminal({ settled, dispose }, pty);
  const chatter = setInterval(() => emit("x"), 1);
  await vi.advanceTimersByTimeAsync(terminalDrainTimeoutMs - 1);
  expect(dispose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  clearInterval(chatter);
  await drained;
  expect(dispose).toHaveBeenCalledOnce();
});
