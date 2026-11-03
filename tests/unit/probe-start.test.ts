/**
 * Unit coverage for recognizing the probe shell's start line in a chunked stream, on either of
 * its channels (PRD §9.2, C-PERF-05). Pipes may split the line anywhere, so it is fed byte by byte.
 */

import { expect, test } from "vitest";
import {
  announcesStart,
  ProbeStart,
  probeCommandStartLine,
  probeStartScript,
} from "../../src/runtime/probe/start.ts";
import { StreamMarkerWatcher } from "../../src/runtime/stream-marker.ts";

const line = `${probeCommandStartLine}\n`;
/** A watcher for the start line, as the probe runner keeps one per channel. */
const startWatcher = () => new StreamMarkerWatcher(Buffer.from(line));

test("C-PERF-05 the start line is recognized once, even split into single bytes", () => {
  const watcher = startWatcher();
  const bytes = Buffer.from(`profile noise\n${line}late stderr ${line}`);
  const hits: number[] = [];
  for (let i = 0; i < bytes.length; i += 1)
    if (watcher.feed(bytes.subarray(i, i + 1))) hits.push(i);
  expect(hits).toEqual([`profile noise\n${line}`.length - 1]);
});

test("C-PERF-05 output without the full start line never ends the launch phase", () => {
  const watcher = startWatcher();
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
  const watcher = startWatcher();
  watcher.feed(Buffer.alloc(1_000_000, 0x61));
  const tail: unknown = Reflect.get(watcher, "tail");
  expect(Buffer.isBuffer(tail) && tail.length === probeCommandStartLine.length).toBe(true);
  // An unresolved probe's reaper retains the watcher; it must not pin the 1 MB chunk.
  expect(Buffer.isBuffer(tail) && tail.buffer.byteLength < 1_000_000).toBe(true);
});

test("C-PERF-05 the first channel to carry the start line starts the command, once", () => {
  const viaControl = new ProbeStart();
  expect(viaControl.feed("control", Buffer.from(line))).toBe(true);
  expect(viaControl.started).toBe(true);
  expect(viaControl.feed("stdout", Buffer.from(line))).toBe(false); // the command's own output
  expect(viaControl.stripFromStdout(`2.1.310\n${line}`)).toBe(`2.1.310\n${line}`);
  const viaStdout = new ProbeStart();
  expect(viaStdout.started).toBe(false);
  expect(viaStdout.feed("stdout", Buffer.from(`noise ${line}`))).toBe(true);
  expect(viaStdout.started).toBe(true);
  expect(viaStdout.feed("control", Buffer.from(line))).toBe(false);
});

test("C-PERF-05 a start line that arrived on stdout is removed from captured stdout", () => {
  const start = new ProbeStart();
  const captured = `noise ${line}2.1.310\n`;
  expect(start.stripFromStdout(captured)).toBe(captured); // not yet seen
  start.feed("stdout", Buffer.from(`noise ${line}`));
  expect(start.stripFromStdout(captured)).toBe("noise 2.1.310\n");
  expect(start.stripFromStdout("")).toBe(""); // a settled probe's released capture
});
