/** Byte-based terminal backpressure regressions (PRD §4.1, C-PERF-06). */

import { expect, test, vi } from "vitest";
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
