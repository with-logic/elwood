/**
 * Which capture a probe gets, and the two that read a process's own pipes (PRD §9.2, C-PERF-03,
 * C-PERF-05): a probe script that `exec`s its command into the output placeholder gets named
 * pipes; a script answered by its status alone gets its shell's own pipes drained and nothing
 * kept; any other command gets its own stdout and stderr, each read up to the cap. Real Node
 * children write the output.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { maxProbeStreamOutputBytes } from "../../src/runtime/probe/capped-buffer.ts";
import { type ProbeCapture, probeCapture } from "../../src/runtime/probe/capture.ts";
import { NamedPipeCapture } from "../../src/runtime/probe/named-pipes.ts";
import { probeOutputRedirect, probeStartScript } from "../../src/runtime/probe/start.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

type Child = ChildProcessByStdio<null, Readable, Readable>;

/** A Node child running `code`, its stdout and stderr piped. */
function node(code: string): Child {
  return spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Watches `child` with `capture` until the child closes; whether the capture overflowed. */
function watched(capture: ProbeCapture, child: Child): Promise<boolean> {
  let overflowed = false;
  capture.watch(child, { overflowed: () => (overflowed = true), ended: () => {} });
  return new Promise((resolve) => child.once("close", () => resolve(overflowed)));
}

test("C-PERF-05 a probe script that execs into the placeholder gets named pipes", async () => {
  vi.stubEnv("TMPDIR", tempDir("elwood-capture-tmpdir-"));
  const capture = await probeCapture(["-c", `exec codex --version ${probeOutputRedirect}`]);
  expect(capture).toBeInstanceOf(NamedPipeCapture);
  capture.release();
});

test("C-PERF-05 a status-only probe script drains its shell's output and keeps none", async () => {
  const args = ["-c", `${probeStartScript}command -v codex >/dev/null 2>&1`];
  const capture = await probeCapture(args);
  expect(capture.args(args)).toBe(args);
  // More than a pipe holds: undrained, the child would block on its write and never close.
  const child = node("process.stdout.write('x'.repeat(1 << 20)); console.error('profile')");
  expect(await watched(capture, child)).toBe(false);
  expect([capture.ended(), capture.text()]).toEqual([true, ["", ""]]);
  capture.release();
});

test.each([
  ["with arguments", ["-e", "0"]],
  ["with none", []],
])("C-PERF-03 a direct command %s keeps its own stdout and stderr", async (_, args) => {
  const capture = await probeCapture(args);
  expect(capture.args(args)).toBe(args);
  const child = node("process.stdout.write('out'); process.stderr.write('err')");
  expect(await watched(capture, child)).toBe(false);
  expect([capture.ended(), capture.text()]).toEqual([true, ["out", "err"]]);
  capture.release();
  expect(capture.text()).toEqual(["", ""]);
});

test("C-PERF-03 a direct command's stream past the cap is reported and cut at it", async () => {
  const capture = await probeCapture(["-e", "0"]);
  const child = node(`process.stderr.write('x'.repeat(${maxProbeStreamOutputBytes + 1}))`);
  expect(await watched(capture, child)).toBe(true);
  expect(capture.text()[1]).toHaveLength(maxProbeStreamOutputBytes);
  capture.release();
});
