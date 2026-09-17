/** Byte-based terminal backpressure regressions (PRD §4.1, C-PERF-06). */

import { expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { attachPtyTerminal } from "../../src/terminal/headless.ts";
import {
  PtyOutput,
  renderHighWaterBytes,
  renderLowWaterBytes,
} from "../../src/terminal/pty-output.ts";

function controlledOutput() {
  const callbacks: Array<() => void> = [];
  const flow = { pause: vi.fn(), resume: vi.fn() };
  const output = new PtyOutput(() => new Promise((resolve) => callbacks.push(resolve)), flow);
  return { output, flow, callbacks };
}

test("C-PERF-06 staged and submitted UTF-8 bytes share the pause/resume thresholds", async () => {
  const { output, flow, callbacks } = controlledOutput();
  output.push("é".repeat(renderLowWaterBytes / 2));
  output.push("x".repeat(renderLowWaterBytes));
  output.push("x");
  expect(flow.pause).toHaveBeenCalledTimes(1);
  for (const complete of callbacks.splice(0, 8)) complete();
  await Promise.resolve();
  expect(flow.resume).not.toHaveBeenCalled();
  output.flush();
  callbacks.pop()!();
  await Promise.resolve();
  expect(flow.resume).not.toHaveBeenCalled(); // exactly the low watermark stays paused
  callbacks.shift()!();
  await Promise.resolve();
  expect(flow.resume).toHaveBeenCalledTimes(1);
  for (const complete of callbacks) complete();
  await Promise.resolve();
  output.dispose();
  expect(flow.resume).toHaveBeenCalledTimes(1);
});

test("C-PERF-06 disposal resumes paused PTYs and ignores later completions/input", async () => {
  const { output, flow, callbacks } = controlledOutput();
  output.push("x".repeat(renderHighWaterBytes + 1));
  expect(flow.pause).toHaveBeenCalledTimes(1);
  output.dispose();
  output.push("late");
  for (const complete of callbacks) complete();
  await Promise.resolve();
  output.flush();
  expect(callbacks).toHaveLength(16);
  expect(flow.resume).toHaveBeenCalledTimes(1);
});

test("C-PERF-06 child exit lifts the pause and never re-pauses a dead producer", async () => {
  const { output, flow, callbacks } = controlledOutput();
  output.push("x".repeat(renderHighWaterBytes + 1));
  expect(flow.pause).toHaveBeenCalledTimes(1);
  // The child exited with the backlog still pending: reads must resume NOW, well
  // before disposal, or node-pty can destroy the socket with the tail unread.
  output.releaseFlowControl();
  expect(flow.resume).toHaveBeenCalledTimes(1);
  // Tail output delivered after exit must not re-pause a PTY nobody will resume.
  output.push("x".repeat(renderHighWaterBytes + 1));
  expect(flow.pause).toHaveBeenCalledTimes(1);
  for (const complete of callbacks) complete();
  await Promise.resolve();
  expect(flow.resume).toHaveBeenCalledTimes(1);
  output.dispose();
});

test("C-PERF-06 attachPtyTerminal resumes a paused PTY when the child exits", async () => {
  const flow = { pause: vi.fn(), resume: vi.fn() };
  let emit: (data: string) => void = () => undefined;
  let exit: () => void = () => undefined;
  const renders: Array<() => void> = [];
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      emit = handler;
      return () => undefined;
    },
    onExit: (handler) => {
      exit = () => handler({ exitCode: 0 });
      return () => undefined;
    },
    write: () => undefined,
    resize: () => "resized",
    kill: () => undefined,
    flowControl: flow,
  };
  const terminal = attachPtyTerminal({ cols: 10, rows: 3 }, pty, () =>
    renders.push(() => undefined),
  );
  emit("x".repeat(renderHighWaterBytes + 1));
  expect(flow.pause).toHaveBeenCalledTimes(1);
  expect(flow.resume).not.toHaveBeenCalled();
  exit(); // reads resume at exit, not at disposal
  expect(flow.resume).toHaveBeenCalledTimes(1);
  await terminal.settled();
  terminal.dispose();
  expect(flow.resume).toHaveBeenCalledTimes(1); // disposal finds nothing left to resume
  expect(renders.length).toBeGreaterThan(0);
});

test("C-PERF-06 a rejected render still releases its bytes and resumes the PTY", async () => {
  const flow = { pause: vi.fn(), resume: vi.fn() };
  const rejections: Array<(error: unknown) => void> = [];
  const output = new PtyOutput(
    () => new Promise((_resolve, reject) => rejections.push(reject)),
    flow,
  );
  output.push("x".repeat(renderHighWaterBytes + 1));
  expect(flow.pause).toHaveBeenCalledTimes(1);
  // Every submitted write fails. The reservation must still be released, or a real
  // PTY would stay paused until disposal with nothing left to drain it.
  for (const reject of rejections) reject(new Error("render failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(flow.resume).toHaveBeenCalledTimes(1);
  output.dispose();
});

test("C-PERF-06 adapters without flow control still render a burst", async () => {
  let rendered = 0;
  const output = new PtyOutput((data) => {
    rendered += data.length;
    return Promise.resolve();
  }, undefined);
  output.push("x".repeat(renderHighWaterBytes));
  output.flush();
  await Promise.resolve();
  expect(rendered).toBe(renderHighWaterBytes);
  output.dispose();
});
