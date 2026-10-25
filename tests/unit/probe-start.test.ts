/**
 * Unit coverage for recognizing the probe shell's start line in a chunked stderr stream
 * (PRD §9.2, C-PERF-05). Pipes may split the line anywhere, so it is fed byte by byte.
 */

import { expect, test } from "vitest";
import {
  announcesStart,
  ProbeStartWatcher,
  probeCommandStartLine,
  probeStartScript,
} from "../../src/runtime/probe/start.ts";

const line = `${probeCommandStartLine}\n`;

test("C-PERF-05 the start line is recognized once, even split into single bytes", () => {
  const watcher = new ProbeStartWatcher();
  const bytes = Buffer.from(`profile noise\n${line}late stderr ${line}`);
  const hits: number[] = [];
  for (let i = 0; i < bytes.length; i += 1)
    if (watcher.feed(bytes.subarray(i, i + 1))) hits.push(i);
  expect(hits).toEqual([`profile noise\n${line}`.length - 1]);
});

test("C-PERF-05 output without the full start line never ends the launch phase", () => {
  const watcher = new ProbeStartWatcher();
  expect(watcher.feed(Buffer.from(probeCommandStartLine))).toBe(false); // no newline yet
  expect(watcher.feed(Buffer.from(" more\n"))).toBe(false);
  expect(watcher.feed(Buffer.from("x".repeat(100)))).toBe(false);
});

test("C-PERF-05 only a script that writes the start line first announces its command", () => {
  expect(announcesStart(["-l", "-i", "-c", `${probeStartScript}claude --version`])).toBe(true);
  expect(announcesStart(["-e", "process.exit(0)"])).toBe(false);
  expect(announcesStart([])).toBe(false);
});

test("C-PERF-03 the watcher keeps a copy of a split line's tail, not a view of the whole chunk", () => {
  const watcher = new ProbeStartWatcher();
  watcher.feed(Buffer.alloc(1_000_000, 0x61));
  const tail: unknown = Reflect.get(watcher, "tail");
  expect(Buffer.isBuffer(tail) && tail.length === probeCommandStartLine.length).toBe(true);
  // An unresolved probe's reaper retains the watcher; it must not pin the 1 MB chunk.
  expect(Buffer.isBuffer(tail) && tail.buffer.byteLength < 1_000_000).toBe(true);
});
