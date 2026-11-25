/** Native arrival watermarks survive PTY batching and ordered rendering (C-API-31). */
import { expect, test, vi } from "vitest";
import { reportCallerInput } from "../../src/codex/session/caller-input.ts";
import { SessionInputOwnership } from "../../src/runtime/session/session-input.ts";
import {
  captureRenderProgress,
  onNativeRenderEvidenceInvalidated,
  settledLiveSnapshot,
} from "../../src/terminal/cursor.ts";
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";
import { renderBatchBytes } from "../../src/terminal/pty-output.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

test("C-API-31 bytes already received before capture stay old when the PTY batch renders", async () => {
  const { terminal, emit } = setupTerminalPty();
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
  const { terminal, emit } = setupTerminalPty();
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
      expect(settledLiveSnapshot(terminal)).toBeUndefined();
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
  const { terminal, emit } = setupTerminalPty((data) => rendered.push(data));
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

const terminalViews = [
  { name: "attached terminal", view: (terminal: ElwoodTerminal) => terminal },
  {
    name: "session terminal",
    view: (terminal: ElwoodTerminal) => new SessionInputOwnership(terminal).caller,
  },
  {
    name: "Codex startup terminal",
    view: (terminal: ElwoodTerminal) => reportCallerInput(terminal, () => {}).terminal,
  },
];

test.each(
  terminalViews,
)("C-API-56 host writes through the $name cannot satisfy PTY-only progress", async ({ view }) => {
  const { terminal: inner, emit } = setupTerminalPty();
  const terminal = view(inner);
  try {
    const progressed = captureRenderProgress(terminal, "pty");
    await terminal.writeOutput("host ");
    expect(progressed()).toBe(false);

    // Exercise an untyped host call with extra arguments.
    const callback = vi.fn();
    await Reflect.apply(terminal.writeOutput, terminal, ["output", callback, true]);
    expect(terminal.snapshot().text).toContain("host output");
    expect(progressed()).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    emit(" from PTY");
    await terminal.settled();
    expect(terminal.snapshot().text).toContain("host output from PTY");
    expect(progressed()).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-API-31 raw output received by a render observer stays unsettled until its render", async () => {
  const facts: boolean[] = [];
  const { terminal, emit } = setupTerminalPty((data) => {
    if (data === "first") emit("second");
    facts.push(settledLiveSnapshot(terminal) !== undefined);
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

test("C-API-31 and C-TRUST-01 a failed native render cannot authorize freshness after later output", async () => {
  const { terminal, emit } = setupTerminalPty();
  const invalidated = vi.fn();
  const unsubscribe = onNativeRenderEvidenceInvalidated(terminal, invalidated);
  const write = vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  try {
    const captured = captureRenderProgress(terminal);
    emit("lost");
    await terminal.settled();
    expect(terminal.renderFailed).toBe(true);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(captured()).toBe(false);
    emit("later");
    await terminal.settled();
    expect(terminal.snapshot().text).toContain("later");
    expect(captured()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    write.mockRestore();
    terminal.dispose();
  }
});

test("C-API-31 an older render callback cannot complete newer native bytes", async () => {
  const { terminal, emit } = setupTerminalPty();
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
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    expect(captured()).toBe(false);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    expect(settledLiveSnapshot(terminal)).toBeUndefined();
    callbacks[1]?.();
    await settled;
    expect(settledLiveSnapshot(terminal)).toBeDefined();
    expect(captured()).toBe(false);
  } finally {
    write.mockRestore();
    terminal.dispose();
  }
});
