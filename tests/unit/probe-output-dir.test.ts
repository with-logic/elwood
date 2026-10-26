/**
 * A probe script's private output directory is made with mode 0700 under the temp directory
 * and removed however the probe settles, and the files in it carry the byte cap (PRD §9.2,
 * C-PERF-03, C-PERF-05). Each test points TMPDIR at a directory of its own and checks that the
 * probe left it empty.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { capturePollMs, setCapturePollForTests } from "../../src/runtime/probe/capture.ts";
import {
  resetProbeTimeoutsForTests,
  runProbe,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import { probeScript } from "../../src/runtime/probe/start.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resetProbeTimeoutsForTests();
  setCapturePollForTests(capturePollMs);
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

test("C-PERF-05 the command writes into a private directory, mode 0700, removed on success", async () => {
  const tmp = privateTmp();
  const result = await probe(`/bin/sh -c 'ls -ld "$ELWOOD_PROBE_OUTPUT"'`);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toMatch(/^drwx------/);
  expect(result.stdout).toContain(` ${join(tmp, "elwood-probe-")}`);
  expect(readdirSync(tmp)).toEqual([]);
});

test.each([
  ["a non-zero exit", () => probe("/bin/sh -c 'exit 3'"), { status: 3 }],
  ["a signal death", () => probe("/bin/sh -c 'kill -TERM $$'"), { status: 143 }],
  ["a missing shell", () => probe("true", "true", "/nonexistent/elwood-shell"), { status: null }],
  ["a shell that exits before its command", () => probe("true", "exit 0"), { status: null }],
])("C-PERF-05 the private directory is removed after %s", async (_, run, expected) => {
  const tmp = privateTmp();
  expect(await run()).toMatchObject(expected);
  expect(readdirSync(tmp)).toEqual([]);
});

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

test("C-PERF-03 a command still writing past the cap is killed at the next poll", async () => {
  const tmp = privateTmp();
  const result = await probe("yes");
  expect(result.error).toMatchObject({ code: "E2BIG" });
  expect(result.stdout).toHaveLength(1_000_000);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-03 a command that exits over the cap before a poll still overflows", async () => {
  const tmp = privateTmp();
  setCapturePollForTests(60_000);
  const result = await probe("/bin/sh -c 'head -c 1000001 /dev/zero; echo err >&2'");
  expect(result).toMatchObject({ status: null, stderr: "err\n", error: { code: "E2BIG" } });
  expect(result.stdout).toHaveLength(1_000_000);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-05 a spawn that throws leaves no private directory", async () => {
  const tmp = privateTmp();
  await expect(probe("true", "true", "/bin/sh\0")).rejects.toThrow(/null bytes/);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-05 a probe that cannot make its private directory fails without running", async () => {
  const tmp = privateTmp();
  vi.stubEnv("TMPDIR", join(tmp, "missing"));
  const result = await probe(`/bin/sh -c 'touch ${join(tmp, "ran")}'`);
  expect(result).toEqual({
    status: null,
    stdout: "",
    stderr: "",
    error: { message: expect.stringMatching(/^could not create the probe's private output/) },
  });
  expect(readdirSync(tmp)).toEqual([]);
});
