/** Recovery freshness tracks completed native output, not snapshot geometry (C-API-31). */
import { expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { captureRenderProgress } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-31 output already received at Enter and viewport changes cannot authorize recovery", async () => {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, () => undefined);
  try {
    const pending = terminal.writeOutput("draft");
    const progressed = captureRenderProgress(terminal);
    expect(progressed()).toBe(false);
    await pending;
    expect(progressed()).toBe(false);
    terminal.resize({ cols: 79, rows: 10 });
    expect(progressed()).toBe(false);
    await terminal.writeOutput("\u001b[?2026hmore");
    expect(progressed()).toBe(false);
    await terminal.writeOutput("\u001b[?2026l");
    expect(progressed()).toBe(true);
    const nextAttempt = captureRenderProgress(terminal);
    expect(nextAttempt()).toBe(false);
    await terminal.writeOutput("\r\ndraft");
    expect(nextAttempt()).toBe(true);
    terminal.dispose();
    expect(nextAttempt()).toBe(false);
    expect(captureRenderProgress(terminal)()).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-API-31 retry preparation precedes first Enter and captures an in-write native repaint", async () => {
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, (value) => {
    writes.push(String(value));
    if (value === "\r") void terminal.writeOutput("\r\ndraft");
  });
  const closing = new AbortController();
  let prepared = false;
  try {
    await terminal.writeOutput("draft");
    vi.useFakeTimers();
    const sent = writeQueuedInput(
      terminal,
      "draft",
      "pasted_input",
      {
        prepareStaged: () => {
          expect(writes).toEqual([]);
          prepared = true;
          return () => true;
        },
        captureRenderProgress: () => {
          expect(prepared).toBe(true);
          return captureRenderProgress(terminal);
        },
      },
      closing.signal,
    );
    await vi.advanceTimersByTimeAsync(150);
    await sent;
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.filter((value) => value === "\r")).toHaveLength(2);
  } finally {
    closing.abort();
    terminal.dispose();
    vi.useRealTimers();
  }
});
