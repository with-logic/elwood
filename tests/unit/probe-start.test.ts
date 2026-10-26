/**
 * Unit coverage for recognizing the probe shell's start line in a chunked stream, on either of
 * its channels, and for keeping only the command's output between the start and end lines
 * (PRD §9.2, C-PERF-05). Pipes may split the line anywhere, so it is fed byte by byte.
 */

import { expect, test } from "vitest";
import {
  announcesStart,
  ProbeStart,
  ProbeStartWatcher,
  probeCommandEndLine,
  probeCommandStartLine,
  probeScript,
} from "../../src/runtime/probe/start.ts";

const line = `${probeCommandStartLine}\n`;
const end = `${probeCommandEndLine}\n`;

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

test("C-PERF-05 only a script that writes the start line announces its command", () => {
  expect(announcesStart(["-l", "-i", "-c", probeScript("claude --version")])).toBe(true);
  expect(announcesStart(["-c", `profile; ${probeScript("claude --version")}`])).toBe(true);
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

test("C-PERF-05 the first channel to carry the start line starts the command, once", () => {
  const viaControl = new ProbeStart([]);
  expect(viaControl.feed("control", Buffer.from(line))).toBe(true);
  expect(viaControl.started).toBe(true);
  expect(viaControl.feed("stdout", Buffer.from(line))).toBe(false); // the command's own output
  const viaStdout = new ProbeStart([]);
  expect(viaStdout.started).toBe(false);
  expect(viaStdout.feed("stdout", Buffer.from(`noise ${line}`))).toBe(true);
  expect(viaStdout.started).toBe(true);
  expect(viaStdout.feed("control", Buffer.from(line))).toBe(false);
});

test("C-PERF-05 a probe keeps only what its command wrote between the start and end lines", () => {
  const start = new ProbeStart(["-c", probeScript("claude --version")]);
  // Startup output, a second start line merged from stderr, a last line without a newline, and
  // the shell's exit output after the end line.
  const stream = `SECRET ${line}${line}out\npartial${end}${end}exit SECRET\n`;
  expect(start.kept(stream)).toBe("out\npartial");
  expect(start.kept(`SECRET ${line}cut off`)).toBe("cut off"); // a bound killed the command
  expect(start.kept("SECRET\n")).toBe(""); // the stream never reached the command
  expect(new ProbeStart(["-c", "echo direct"]).kept(`raw ${line}`)).toBe(`raw ${line}`);
});
