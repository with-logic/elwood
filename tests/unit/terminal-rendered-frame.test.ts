/** Current frame evidence is shared and cached only across unchanged renders (C-TRUST-01). */
import xtermHeadless from "@xterm/headless";
import { expect, test, vi } from "vitest";
import {
  cachedLiveSnapshot,
  captureRenderProgress,
  hasUnknownOrNonPristineOutput,
  settledLiveSnapshot,
  subscribeRender,
} from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { RenderCursor, renderCursorOf } from "../../src/terminal/render-cursor.ts";

test("C-TRUST-01 current frame reuses a completed snapshot and invalidates on output and resize", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  try {
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    expect(hasUnknownOrNonPristineOutput(terminal)).toBe(false);
    await terminal.writeOutput("first");
    expect(hasUnknownOrNonPristineOutput(terminal)).toBe(true);
    const first = cachedLiveSnapshot(terminal);
    expect(settledLiveSnapshot(terminal)).toBe(first);
    expect(cachedLiveSnapshot(terminal)).toBe(first);
    const pending = terminal.writeOutput(" second");
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    await pending;
    const second = settledLiveSnapshot(terminal);
    expect(second?.text).toContain("first second");
    expect(second).not.toBe(first);
    terminal.resize({ cols: 30, rows: 5 });
    const resized = settledLiveSnapshot(terminal);
    expect(resized?.cols).toBe(30);
    expect(resized?.rows).toBe(5);
    expect(resized).not.toBe(second);
    await terminal.writeOutput("\u001b[?2026h");
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    await terminal.writeOutput("\u001b[?2026l");
    expect(settledLiveSnapshot(terminal)).toBeDefined();
    vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    await expect(terminal.writeOutput("failed")).rejects.toThrow("render failed");
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    expect(renderCursorOf(terminal.xterm)).toBeInstanceOf(RenderCursor);
  } finally {
    terminal.dispose();
  }
  expect(renderCursorOf(terminal.xterm)).toBeUndefined();
  expect(settledLiveSnapshot(terminal)).toBeUndefined();
  expect(hasUnknownOrNonPristineOutput(terminal)).toBe(true);
  expect(cachedLiveSnapshot(terminal).text).toContain("first second");
});

test("C-API-15 disposal detaches frame invalidation from retained raw xterm handles", async () => {
  const terminal = new xtermHeadless.Terminal({ allowProposedApi: true });
  const original = { write: terminal.write, writeln: terminal.writeln, reset: terminal.reset };
  const cursor = new RenderCursor(terminal, () => false);
  try {
    expect(renderCursorOf(terminal)).toBe(cursor);
    expect(terminal.write).not.toBe(original.write);
    cursor.dispose();
    expect(renderCursorOf(terminal)).toBeUndefined();
    expect(terminal.write).toBe(original.write);
    expect(terminal.writeln).toBe(original.writeln);
    expect(terminal.reset).toBe(original.reset);
    await new Promise<void>((resolve) => terminal.writeln("still usable", resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("still usable");
    terminal.reset();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");
  } finally {
    cursor.dispose();
    terminal.dispose();
  }
});

const rawMethods: readonly ("write" | "writeln")[] = ["write", "writeln"];
const rawWrites = rawMethods.flatMap((method) =>
  [false, true].map((callback) => ({ method, callback })),
);

test.each(rawWrites)("C-API-15 raw $method refreshes frames (callback: $callback)", async ({
  method,
  callback,
}) => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  try {
    // A partial scroll region keeps even writeln's final cursor/viewport geometry equal.
    await terminal.writeOutput("\u001b[2;3r\u001b[3;1Hfirst\u001b[3;1H");
    const first = settledLiveSnapshot(terminal);
    const progressed = captureRenderProgress(terminal);
    const parsed = Promise.withResolvers<void>();
    const listener = terminal.xterm.onWriteParsed(() => {
      listener.dispose();
      parsed.resolve();
    });
    const done = vi.fn(() => {
      expect(settledLiveSnapshot(terminal)?.text).toContain("other");
    });
    terminal.xterm[method]("\u001b[3;1Hother\u001b[3;1H", callback ? done : undefined);
    await parsed.promise;
    const next = settledLiveSnapshot(terminal);
    expect(next?.text).toContain("other");
    expect(next?.cursorX).toBe(first?.cursorX);
    expect(next?.cursorY).toBe(first?.cursorY);
    expect(next).not.toBe(first);
    expect(progressed()).toBe(false);
    expect(done).toHaveBeenCalledTimes(callback ? 1 : 0);
  } finally {
    terminal.dispose();
  }
});

test("C-API-15 a raw tail in the owned write's drain refreshes its cached frame", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  const parsed: string[] = [];
  const owned: string[] = [];
  terminal.xterm.onWriteParsed(() => parsed.push(cachedLiveSnapshot(terminal).text));
  const unsubscribe = subscribeRender(terminal, () => {
    owned.push(cachedLiveSnapshot(terminal).text);
    terminal.xterm.write("\u001b[Hother\u001b[H");
  });
  // xterm parses queued writes in 12 ms slices timed by performance.now(). On a loaded
  // machine the slice can end before the raw tail, which then parses in a later drain,
  // a case the raw-write tests above cover. Freeze the clock so the tail stays in this
  // drain.
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    await terminal.writeOutput("\u001b[Hfirst\u001b[H");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toContain("first");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toContain("other");
    expect(settledLiveSnapshot(terminal)?.text).toBe(parsed[0]);
  } finally {
    unsubscribe();
    terminal.dispose();
    clock.mockRestore();
  }
});

test("C-API-15 writeln's synchronous first parse cannot reuse the prior frame", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput("\u001b[2;3r\u001b[3;1Hfirst\u001b[3;1H");
    expect(settledLiveSnapshot(terminal)?.text).toContain("first");
    const parsed: string[] = [];
    terminal.xterm.onWriteParsed(() => parsed.push(cachedLiveSnapshot(terminal).text));
    terminal.xterm.input("x");
    await new Promise<void>((resolve) => {
      terminal.xterm.writeln("\u001b[3;1Hother\u001b[3;1H", resolve);
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toContain("other");
    expect(parsed[1]).toContain("other");
  } finally {
    terminal.dispose();
  }
});

test.each([
  false,
  true,
])("C-API-15 clear/reset refresh cached live rows (clear: %s)", async (clear) => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput(clear ? "\u001b[Hstale\u001b[3;1H" : "\u001b[2;1Hstale\u001b[H");
    const first = settledLiveSnapshot(terminal);
    expect(first?.text).toContain("stale");
    if (clear) terminal.xterm.clear();
    else terminal.xterm.reset();
    const next = settledLiveSnapshot(terminal);
    expect(next?.text).not.toContain("stale");
    expect(next?.cursorX).toBe(0);
    expect(next?.cursorY).toBe(0);
    if (!clear) expect(first?.cursorY).toBe(next?.cursorY);
    expect(next).not.toBe(first);
  } finally {
    terminal.dispose();
  }
});

test("a resize round trip invalidates cached live rows without manufacturing render progress", async () => {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput("\u001b[4;1HSelect model\u001b[1;1H");
    expect(cachedLiveSnapshot(terminal).text).toContain("Select model");
    const advanced = captureRenderProgress(terminal);
    terminal.xterm.resize(80, 2);
    terminal.xterm.resize(80, 4);
    expect(cachedLiveSnapshot(terminal).text).not.toContain("Select model");
    expect(advanced()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
