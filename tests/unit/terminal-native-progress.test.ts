/** Native arrival watermarks survive PTY batching and ordered rendering (C-API-31). */
import { expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { captureRenderProgress, currentRenderedFrame } from "../../src/terminal/cursor.ts";
import { attachPtyTerminal, type ElwoodTerminal } from "../../src/terminal/headless.ts";
import { renderBatchBytes } from "../../src/terminal/pty-output.ts";

function setup(onRendered: (data: string, terminal: ElwoodTerminal) => void = () => {}) {
  let emit = (_data: string) => {};
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
  const terminal = attachPtyTerminal({ cols: 40, rows: 5 }, pty, onRendered);
  return { terminal, emit };
}

test("C-API-31 bytes already received before capture stay old when the PTY batch renders", async () => {
  const { terminal, emit } = setup();
  try {
    emit("old ");
    emit("output");
    const captured = captureRenderProgress(terminal);
    expect(captured()).toBe(false);
    await terminal.settled();
    expect(terminal.snapshot().text).toContain("old output");
    expect(captured()).toBe(false);
    emit("new output");
    await terminal.settled();
    expect(captured()).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-API-31 a split native chunk needs every render before proving fresh output", async () => {
  const { terminal, emit } = setup();
  const callbacks: Array<() => void> = [];
  const write = vi.spyOn(terminal.xterm, "write").mockImplementation((_data, done) => {
    if (done) callbacks.push(done);
  });
  try {
    const captured = captureRenderProgress(terminal);
    emit("x".repeat(renderBatchBytes * 2 + 1));
    const settled = terminal.settled();
    expect(callbacks).toHaveLength(3);
    for (const callback of callbacks.slice(0, -1)) {
      callback();
      expect(captured()).toBe(false);
      expect(currentRenderedFrame(terminal)).toBeUndefined();
    }
    callbacks.at(-1)?.();
    await settled;
    expect(captured()).toBe(true);
  } finally {
    write.mockRestore();
    terminal.dispose();
  }
});

test("C-API-31 a direct write follows staged native output and owns fresh progress", async () => {
  const rendered: string[] = [];
  const { terminal, emit } = setup((data) => rendered.push(data));
  try {
    emit("native ");
    const captured = captureRenderProgress(terminal);
    await terminal.writeOutput("direct");
    await terminal.settled();
    expect(rendered).toEqual(["native "]);
    expect(terminal.snapshot().text).toContain("native direct");
    expect(captured()).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-API-31 raw output received by a render observer stays unsettled until its render", async () => {
  const facts: boolean[] = [];
  const { terminal, emit } = setup((data) => {
    if (data === "first") emit("second");
    facts.push(currentRenderedFrame(terminal) !== undefined);
  });
  try {
    const captured = captureRenderProgress(terminal);
    emit("first");
    await terminal.settled();
    expect(facts).toEqual([false, true]);
    expect(terminal.snapshot().text).toContain("firstsecond");
    expect(captured()).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-API-31 a failed native render cannot authorize freshness after later output", async () => {
  const { terminal, emit } = setup();
  const write = vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  try {
    const captured = captureRenderProgress(terminal);
    emit("lost");
    await terminal.settled();
    expect(terminal.renderFailed).toBe(true);
    expect(captured()).toBe(false);
    emit("later");
    await terminal.settled();
    expect(terminal.snapshot().text).toContain("later");
    expect(captured()).toBe(false);
  } finally {
    write.mockRestore();
    terminal.dispose();
  }
});

test("C-API-31 an older render callback cannot complete newer native bytes", async () => {
  const { terminal, emit } = setup();
  const callbacks: Array<() => void> = [];
  const write = vi.spyOn(terminal.xterm, "write").mockImplementation((_data, done) => {
    if (done) callbacks.push(done);
  });
  try {
    emit("first");
    const settled = terminal.settled();
    expect(callbacks).toHaveLength(1);
    emit("second");
    const captured = captureRenderProgress(terminal);
    callbacks[0]?.();
    expect(currentRenderedFrame(terminal)).toBeUndefined();
    expect(captured()).toBe(false);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    expect(currentRenderedFrame(terminal)).toBeUndefined();
    callbacks[1]?.();
    await settled;
    expect(currentRenderedFrame(terminal)).toBeDefined();
    expect(captured()).toBe(false);
  } finally {
    write.mockRestore();
    terminal.dispose();
  }
});
