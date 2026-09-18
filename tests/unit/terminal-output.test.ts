/** Terminal render throughput and backpressure regressions (PRD §4.1, C-PERF-06). */

import { expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { attachPtyTerminal, createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-PERF-06 submits consecutive writes to xterm without serial timer barriers", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, () => undefined);
  const write = vi.spyOn(terminal.xterm, "write");
  const first = terminal.writeOutput("first");
  const second = terminal.writeOutput("second");
  expect(write).toHaveBeenCalledTimes(2);
  await Promise.all([first, second, terminal.settled()]);
  expect(terminal.snapshot().text).toContain("firstsecond");
  terminal.dispose();
});

test("C-PERF-06 adjacent PTY chunks share a frame while later batches remain ordered", async () => {
  let emit: (data: string) => void = () => undefined;
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      emit = handler;
      return () => undefined;
    },
    onExit: () => () => undefined,
    write: () => undefined,
    resize: () => "resized",
    kill: () => undefined,
  };
  const frames: string[] = [];
  const terminal = attachPtyTerminal({ cols: 20, rows: 2 }, pty, (_, rendered) => {
    frames.push(rendered.snapshot().lines[0]!);
  });
  emit("A");
  emit("B");
  await terminal.settled();
  emit("C");
  await terminal.settled();
  expect(frames).toEqual(["AB", "ABC"]);
  terminal.dispose();
});

test("C-PERF-06 disposal settles queued writes even when xterm abandons callbacks", async () => {
  const terminal = createHeadlessTerminal({ cols: 20, rows: 3 }, () => undefined);
  vi.spyOn(terminal.xterm, "write").mockImplementation(() => undefined);
  const completed = vi.fn();
  const write = terminal.writeOutput("pending").then(completed);
  const settled = terminal.settled().then(completed);
  terminal.dispose();
  // Both resolve on microtasks alone: no timer fires and no abandoned xterm callback
  // ever arrives, so a hang here means disposal stopped settling the queue at all.
  await Promise.race([
    Promise.all([write, settled]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("settle hung")), 0)),
  ]);
  expect(completed).toHaveBeenCalledTimes(2);
});
