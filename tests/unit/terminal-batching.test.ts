/** Bounded PTY batching preserves Unicode and ANSI bytes (PRD §4.1, C-PERF-05). */

import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { TerminalOutput } from "../../src/terminal/output.ts";
import { PtyOutput, renderBatchBytes } from "../../src/terminal/pty-output.ts";

test("C-PERF-05 a partial batch flushes after four milliseconds without extending its window", () => {
  vi.useFakeTimers();
  const batches: string[] = [];
  const output = new PtyOutput((data) => {
    batches.push(data);
    return Promise.resolve();
  }, undefined);
  try {
    output.push("first");
    vi.advanceTimersByTime(2);
    output.push("second");
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual(["firstsecond"]);
  } finally {
    output.dispose();
    vi.useRealTimers();
  }
});

test("C-PERF-05 batches never exceed 64 KiB or split surrogate pairs", async () => {
  const batches: string[] = [];
  const output = new PtyOutput((data) => {
    batches.push(data);
    return Promise.resolve();
  }, undefined);
  const pieces = ["x".repeat(16_383), "🧑".repeat(50_000), "\u001b[", "31mred\u001b[0m"];
  output.push(pieces.slice(0, 2).join(""));
  output.push(pieces[2]!);
  output.push(pieces[3]!);
  await delay(10);
  expect(batches.join("")).toBe(pieces.join(""));
  expect(batches.every((batch) => Buffer.byteLength(batch) <= renderBatchBytes)).toBe(true);
  expect(batches.every((batch) => Buffer.from(batch).toString("utf8") === batch)).toBe(true);
  output.push("");
  output.flush();
  output.dispose();
});

test("C-PERF-05 batch failures are contained and later writes still complete", async () => {
  const rendered: string[] = [];
  const output = new PtyOutput((data) => {
    rendered.push(data);
    return data === "bad" ? Promise.reject(new Error("render failed")) : Promise.resolve();
  }, undefined);
  output.push("bad");
  output.flush();
  await Promise.resolve();
  output.push("good");
  await delay(10);
  expect(rendered).toEqual(["bad", "good"]);
  output.dispose();
});

test("C-PERF-05 disposal suppresses callbacks retained by xterm", async () => {
  const callbacks: Array<() => void> = [];
  const output = new TerminalOutput((_, callback) => callbacks.push(callback));
  let rendered = false;
  const write = output.enqueue("x", () => {
    rendered = true;
  });
  const settled = output.settled();
  output.dispose();
  callbacks[0]!();
  await Promise.all([write, settled]);
  expect(rendered).toBe(false);
});

test("C-PERF-05 a render callback can dispose its own terminal", async () => {
  const callbacks: Array<() => void> = [];
  const output = new TerminalOutput((_, callback) => callbacks.push(callback));
  const write = output.enqueue("x", () => output.dispose());
  callbacks[0]!();
  await Promise.all([write, output.settled()]);
});
