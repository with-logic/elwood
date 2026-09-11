/** Headed execution integration coverage. Implements PRD §12A.6 and C-CLI-18. */

import { expect, test, vi } from "vitest";
import { HeadedDisplay, terminalRestore } from "../../src/cli/head/display.ts";
import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink, type CliWritable } from "../../src/cli/stream.ts";
import type { TerminalSize } from "../../src/core/types.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const request = effectiveRequest({ initialSize: { cols: 120, rows: 40 } });

test("C-CLI-18 raw TUI output and restore precede the final stdout response", async () => {
  const timeline: string[] = [];
  const stdout = new TimelineWriter("stdout", timeline);
  const stderr = new TimelineWriter("head", timeline);
  let resize: ((size: TerminalSize) => void) | undefined;
  const target: CliHeadTarget = {
    output: stderr,
    size: () => ({ cols: 120, rows: 40 }),
    isRaw: () => false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: () => resize?.({ cols: 77, rows: 22 }),
    onInput: () => () => undefined,
    onResize: (handler) => {
      resize = handler;
      return () => {
        resize = undefined;
      };
    },
  };
  const session = new FakeCliSession();
  const tui = "\u001b[?1049h\u001b[2J\u001b[8;12H\u001b[35m◒ tool\u001b[?25l";
  session.streamWork = (current) => {
    current.emitter.emit("terminal:data", { elwoodSessionId: "s1", data: tui });
    resize?.({ cols: 98, rows: 31 });
    return Promise.resolve();
  };

  expect(
    await executeRun(
      request,
      session,
      { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(new MemoryWriter()) },
      { signals: new FakeSignals(), head: new HeadedDisplay(target) },
    ),
  ).toBe(0);

  expect(stderr.value).toBe(`${tui}${terminalRestore}`);
  expect(session.resizes).toEqual([{ cols: 98, rows: 31 }]);
  expect(timeline.at(-1)).toBe("stdout:ok\n");
});

test("C-CLI-18 keeps raw TUI bytes out of JSON stdout", async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const target: CliHeadTarget = {
    output: stderr,
    size: () => ({ cols: 120, rows: 40 }),
    isRaw: () => false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    onInput: () => () => undefined,
    onResize: () => () => undefined,
  };
  const session = new FakeCliSession();
  const tui = "\u001b[?1049h\u001b[2Jspinner ◓";
  session.streamWork = (current) => {
    current.emitter.emit("terminal:data", { elwoodSessionId: "s1", data: tui });
    return Promise.resolve();
  };

  expect(
    await executeRun(
      { ...request, output: "json", outputExplicit: true },
      session,
      { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(new MemoryWriter()) },
      { signals: new FakeSignals(), head: new HeadedDisplay(target) },
    ),
  ).toBe(0);

  expect(stderr.value).toBe(`${tui}${terminalRestore}`);
  expect(() => JSON.parse(stdout.value)).not.toThrow();
  expect(stdout.value).not.toContain(tui);
  expect(JSON.parse(stdout.value)).toMatchObject({ schemaVersion: 1, type: "result" });
});

test("C-CLI-18 raw Ctrl-C interrupts while early resize and display closure stay contained", async () => {
  const writer = new MemoryWriter();
  writer.failAt = 1;
  let input: ((data: string | Uint8Array) => void) | undefined;
  const target: CliHeadTarget = {
    output: writer,
    size: () => ({ cols: 120, rows: 40 }),
    isRaw: () => false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    onInput: (handler) => {
      input = handler;
      return () => {
        input = undefined;
      };
    },
    onResize: (handler) => {
      handler({ cols: 90, rows: 25 });
      return () => undefined;
    },
  };
  const session = new FakeCliSession();
  session.streamWork = (current) => {
    current.emitter.emit("terminal:data", { elwoodSessionId: "s1", data: "frame" });
    input?.(Buffer.from([0x03]));
    return new Promise(() => {});
  };
  const output = new MemoryWriter();

  expect(
    await executeRun(
      request,
      session,
      { stdout: new AsyncOutputSink(output), stderr: new AsyncOutputSink(new MemoryWriter()) },
      { signals: new FakeSignals(), head: new HeadedDisplay(target) },
    ),
  ).toBe(130);
  expect(session.resizes).toEqual([]);
  expect(session.interrupts).toBe(1);
});

class TimelineWriter extends MemoryWriter implements CliWritable {
  private readonly label: string;
  private readonly timeline: string[];
  constructor(label: string, timeline: string[]) {
    super();
    this.label = label;
    this.timeline = timeline;
  }
  override write(value: string, callback: (error?: Error | null) => void): boolean {
    this.timeline.push(`${this.label}:${value}`);
    return super.write(value, callback);
  }
}
