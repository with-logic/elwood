/**
 * Real-subprocess coverage for the probe's two bounds: the login shell's launch phase,
 * ended by the start line, and the probe command's own bound after it. Covers PRD §9.2,
 * C-PERF-03 and C-PERF-05. `/bin/sh` runs the production probe command string, so the
 * start line under test is the one `probeShellCommand` writes, without loading a profile.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  resetProbeTimeoutsForTests,
  runProbe,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import { probeShellCommand } from "../../src/runtime/shell.ts";
import { pollGone } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

/** A probe shell whose "profile" takes `profile` before the production probe command runs. */
function probe(profile: string, command: string) {
  return runProbe("/bin/sh", ["-c", `${profile}; ${probeShellCommand(command)[3]}`]);
}

afterEach(() => resetProbeTimeoutsForTests());

test("C-PERF-05 a profile slower than the command bound does not fail a fast command", async () => {
  setProbeTimeoutsForTests({ commandMs: 150, launchMs: 10_000 });
  const result = await probe("sleep 0.6", "echo 2.1.310");
  expect(result).toEqual({ status: 0, stdout: "2.1.310\n", stderr: "" });
});

test("C-PERF-05 a shell that never writes the start line is killed at the launch bound", async () => {
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 150 });
  const result = await runProbe("/bin/sh", ["-c", "echo profile-noise >&2; sleep 30"]);
  expect(result.status).toBeNull();
  expect(result.stderr).toBe("profile-noise\n");
  expect(result.error).toMatchObject({
    code: "ETIMEDOUT",
    message: "login shell did not start the probe command within 150 ms",
    phase: "login_shell",
  });
});

test("C-PERF-03 the command bound starts at the start line and still kills a hung command", async () => {
  setProbeTimeoutsForTests({ commandMs: 150, launchMs: 10_000 });
  const started = performance.now();
  const result = await probe("true", "sleep 30");
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(result.error?.message).toBe("probe timed out after 150 ms");
  expect(result.stderr).toBe("");
  expect(performance.now() - started).toBeLessThan(10_000);
});

test("C-PERF-05 the start line never reaches captured stderr", async () => {
  const result = await probe("printf warn >&2", "echo err >&2; exit 2");
  expect(result).toEqual({ status: 2, stdout: "", stderr: "warnerr\n" });
});

test("C-PERF-03 a command-bound timeout kills the command's whole process group", async () => {
  // Generous: the bound must not expire before the command has recorded its grandchild.
  setProbeTimeoutsForTests({ commandMs: 2_000, launchMs: 10_000 });
  const pidFile = join(tempDir("elwood-probe-"), "grandchild.pid");
  const result = await probe("true", `sleep 30 & echo $! > '${pidFile}'; wait`);
  expect(result.error).toMatchObject({
    code: "ETIMEDOUT",
    message: "probe timed out after 2000 ms",
  });
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  expect(grandchild).toBeGreaterThan(0);
  expect(await pollGone({ pid: grandchild, timeoutMs: 2_000 })).toBe(true);
});

test("C-PERF-05 a login shell that exits before announcing its command fails the probe", async () => {
  // An rc file that never returns to the probe, as one that `exec`s another shell would.
  const rc = join(tempDir("elwood-probe-"), "exit.rc");
  writeFileSync(rc, "exit 0\n");
  const script = probeShellCommand("echo 2.1.310")[3];
  const result = await runProbe("/bin/bash", ["--rcfile", rc, "-i", "-c", script]);
  expect(result.status).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.error).toEqual({
    message: "login shell exited with status 0 before starting the probe command",
    phase: "login_shell",
    shellStatus: 0,
  });
});

test.each([
  "exec 2>&1",
  "exec 2>/dev/null",
])("C-PERF-05 a profile that runs `%s` still starts the command bound", async (redirect) => {
  // The start line has its own descriptor, so a profile's stderr redirection cannot hide it.
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 10_000 });
  const rc = join(tempDir("elwood-probe-"), "redirect.rc");
  writeFileSync(rc, `${redirect}\n`);
  const script = probeShellCommand("echo 2.1.310")[3];
  const result = await runProbe("/bin/bash", ["--rcfile", rc, "-i", "-c", script]);
  expect(result).toMatchObject({ status: 0, stdout: "2.1.310\n" });
  expect(result.error).toBeUndefined();
  expect(result.stdout).not.toContain("elwood-probe-command-start");
});

test("C-PERF-05 a start line split across writes still ends the launch phase once complete", async () => {
  // The launch bound would kill the probe; only the completed line hands it the command bound.
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 1_500 });
  const [head, tail] = ["elwood-probe-", "command-start"];
  const script = `printf ${head} >&3; sleep 0.3; printf '${tail}\\n' >&3; sleep 2; echo 2.1.310`;
  const result = await runProbe("/bin/sh", ["-c", script]);
  expect(result).toEqual({ status: 0, stdout: "2.1.310\n", stderr: "" });
});
