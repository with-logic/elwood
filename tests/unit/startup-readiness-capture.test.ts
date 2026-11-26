/**
 * Startup screen capture ends when the session cancels readiness (C-ATTN-06), a frame
 * is completed only while no output has arrived since it rendered (C-ATTN-11), and a re-read
 * hands the frame listener the terminal's current frame, as the deadline does (C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { createStartupReadinessGate } from "../../src/runtime/session/startup-readiness.ts";
import * as cursor from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

afterEach(() => vi.useRealTimers());

const idle = { composer_visible: false, blocking_prompt_visible: false, working_visible: false };

test("C-ATTN-06 stop capturing startup screens after cancellation", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 5 }, () => {});
  const reads = vi.spyOn(cursor, "settledLiveSnapshot");
  const readiness = createStartupReadinessGate(() => {}, false, {
    session: { agent: "claude", elwoodSessionId: "session" },
    configured: () => false,
    nativeStartupScreen: () => false,
    warnings: { emitWarnings: () => {} },
    events: { emit: () => {} },
  });
  try {
    await terminal.writeOutput("Initial screen");
    expect(readiness.observeStartupFrame(terminal).text).toContain("Initial screen");
    expect(reads).toHaveBeenCalledTimes(1);

    readiness.ready.cancel();
    await terminal.writeOutput("\r\nTrailing output");
    expect(readiness.observeStartupFrame(terminal).text).toContain("Trailing output");
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
    terminal.dispose();
  }
});

test("C-ATTN-11 a frame the deadline re-reads after more output arrived is not unrecognized", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 5 }, () => {});
  const emit = vi.fn();
  const readiness = createStartupReadinessGate(() => {}, false, {
    session: { agent: "claude", elwoodSessionId: "session" },
    configured: () => false,
    nativeStartupScreen: () => false,
    warnings: { emitWarnings: () => {} },
    events: { emit },
  });
  try {
    await terminal.writeOutput("Unknown screen");
    const frame = readiness.observeStartupFrame(terminal);
    vi.useFakeTimers();
    readiness.ready.armDeadline();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    expect(readiness.unrecognizedStartup.classify(idle, false, frame)).toBe(true);
    // Output that has not rendered yet, and then output rendered after the frame, make it stale.
    const pending = terminal.writeOutput("\r\nmore");
    expect(readiness.unrecognizedStartup.classify(idle, false, frame)).toBe(false);
    await pending;
    expect(readiness.unrecognizedStartup.classify(idle, false, frame)).toBe(false);
    const next = readiness.observeStartupFrame(terminal);
    expect(readiness.unrecognizedStartup.classify(idle, false, next)).toBe(true);
  } finally {
    readiness.ready.cancel();
    terminal.dispose();
  }
});

test("C-API-28 a re-read hands the frame listener the terminal's current settled frame", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 5 }, () => {});
  const readiness = createStartupReadinessGate(() => {}, false, {
    session: { agent: "codex", elwoodSessionId: "session" },
    configured: () => false,
    nativeStartupScreen: () => false,
    warnings: { emitWarnings: () => {} },
    events: { emit: () => {} },
  });
  const listener = vi.fn();
  try {
    await terminal.writeOutput("Footer screen");
    readiness.observeStartupFrame(terminal);
    readiness.setDeadlineListener(listener);
    readiness.rereadFrame();
    expect(listener).toHaveBeenCalledWith({
      text: expect.stringContaining("Footer screen"),
      cols: 40,
    });
  } finally {
    readiness.ready.cancel();
    terminal.dispose();
  }
});
