/**
 * A probe script's command writes into two named pipes in a private directory, mode 0700 under
 * the temp directory, removed however the probe settles. The pipes read as ordinary pipes do:
 * the probe waits for anything the command started that still holds them, the cap stops a
 * writer at exactly its bytes, and a writer left once the probe ends is stopped by `SIGPIPE`
 * (PRD §9.2, C-PERF-03, C-PERF-05). Each test points TMPDIR at a directory of its own and
 * checks that the probe left it empty.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  resetProbeTimeoutsForTests,
  runProbe,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import { setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { probeScript } from "../../src/runtime/probe/start.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resetProbeTimeoutsForTests();
  setMkfifoForTests();
});

/** A TMPDIR of the test's own, which a probe must leave empty. */
function privateTmp(): string {
  const tmp = tempDir("elwood-probe-tmpdir-");
  vi.stubEnv("TMPDIR", tmp);
  return tmp;
}

/** Runs `command` as a probe script under `/bin/sh`, after `profile`. */
function probe(command: string, profile = "true", shell = "/bin/sh") {
  return runProbe(shell, ["-c", `${profile}; ${probeScript(command)}`]);
}

/** `script` run by `/bin/sh` as the probe's command. */
const sh = (script: string) => `/bin/sh -c ${shellQuote(script)}`;

test("C-PERF-05 the command writes into private named pipes, in a 0700 directory removed after", async () => {
  const tmp = privateTmp();
  const result = await probe(sh('ls -ld "$ELWOOD_PROBE_OUTPUT" "$ELWOOD_PROBE_OUTPUT"/*'));
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const [dir, stderr, stdout] = result.stdout.trim().split("\n");
  expect(dir).toMatch(/^drwx------/);
  expect(dir).toContain(` ${join(tmp, "elwood-probe-")}`);
  for (const pipe of [stderr, stdout]) expect(pipe).toMatch(/^prw-------/);
  expect(readdirSync(tmp)).toEqual([]);
});

test.each([
  ["a non-zero exit", () => probe(sh("exit 3")), { status: 3 }],
  ["a signal death", () => probe(sh("kill -TERM $$")), { status: 143 }],
  ["a missing shell", () => probe("true", "true", "/nonexistent/elwood-shell"), { status: null }],
  ["a shell that exits before its command", () => probe("true", "exit 0"), { status: null }],
  ["a command that locks its directory", () => probe(sh(lockOwnDirectory)), { status: 0 }],
  ["a command that removes its directory", () => probe(sh(removeOwnDirectory)), { status: 0 }],
])("C-PERF-05 the private directory is removed after %s", async (_, run, expected) => {
  const tmp = privateTmp();
  expect(await run()).toMatchObject(expected);
  expect(readdirSync(tmp)).toEqual([]);
});

const lockOwnDirectory =
  'mkdir "$ELWOOD_PROBE_OUTPUT/inner" && chmod 000 "$ELWOOD_PROBE_OUTPUT/inner" "$ELWOOD_PROBE_OUTPUT"';
const removeOwnDirectory = 'rm -rf "$ELWOOD_PROBE_OUTPUT"';

test.each([
  ["launch", { commandMs: 10_000, launchMs: 150 }, "sleep 30"],
  ["command", { commandMs: 150, launchMs: 10_000 }, "true"],
])("C-PERF-03 the private directory is removed after the %s bound", async (_, bounds, profile) => {
  const tmp = privateTmp();
  setProbeTimeoutsForTests(bounds);
  const result = await probe("sleep 30", profile);
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(readdirSync(tmp)).toEqual([]);
});

test.each([
  ["stdout", "yes", "stdout"],
  ["stderr", sh("yes >&2"), "stderr"],
  ["stdout, from a command that exits over it", sh("head -c 1000001 /dev/zero"), "stdout"],
] as const)("C-PERF-03 a command writing past the cap on %s is stopped at it", async (_, command, stream) => {
  const tmp = privateTmp();
  const result = await probe(command);
  expect(result.error).toMatchObject({ code: "E2BIG" });
  expect(result[stream]).toHaveLength(1_000_000);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-03 the probe waits for what its command started that still holds its output", async () => {
  const tmp = privateTmp();
  const result = await probe(sh("(sleep 0.3; echo late; echo late >&2) & echo early"));
  expect(result).toEqual({ status: 0, stdout: "early\nlate\n", stderr: "late\n" });
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-03 a writer left when the probe's bound ends it is stopped by SIGPIPE", async () => {
  privateTmp();
  const beats = join(tempDir("elwood-probe-writer-"), "beats");
  // A helper the command leaves behind keeps writing, counting each line, for at most 3 s.
  const writer = `i=0; while [ $i -lt 60 ] && echo x; do i=$((i+1)); echo $i > ${beats}; sleep 0.05; done`;
  setProbeTimeoutsForTests({ commandMs: 300, launchMs: 10_000 });
  const result = await probe(sh(`(${writer}) & exit 0`));
  expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stopped = readFileSync(beats, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readFileSync(beats, "utf8")).toBe(stopped);
});

test("C-PERF-05 a spawn that throws leaves no private directory", async () => {
  const tmp = privateTmp();
  await expect(probe("true", "true", "/bin/sh\0")).rejects.toThrow(/null bytes/);
  expect(readdirSync(tmp)).toEqual([]);
});

test.each([
  ["its directory", () => vi.stubEnv("TMPDIR", "/nonexistent/elwood-tmp"), { code: "ENOENT" }],
  ["its named pipes", () => setMkfifoForTests("/nonexistent/elwood-mkfifo"), { code: "ENOENT" }],
  // `mkfifo` ran and failed: its exit status is no errno.
  ["its named pipes, mkfifo failing", () => setMkfifoForTests("/usr/bin/false"), {}],
])("C-PERF-05 a probe that cannot make %s fails without running", async (_, breakIt, errno) => {
  const tmp = privateTmp();
  breakIt();
  const ran = join(tempDir("elwood-probe-ran-"), "ran");
  const result = await probe(`touch ${ran}`);
  expect(result).toEqual({
    status: null,
    stdout: "",
    stderr: "",
    error: {
      message: expect.stringMatching(/^could not create the probe's private output pipes: /),
      ...errno,
    },
  });
  expect(readdirSync(tmp)).toEqual([]);
  expect(() => readFileSync(ran)).toThrow(/ENOENT/);
});
