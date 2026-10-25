/**
 * Real-subprocess coverage for the probe's two bounds: the login shell's launch phase,
 * ended by the start line, and the probe command's own bound after it. Covers PRD §9.2,
 * C-PERF-03 and C-PERF-05. `/bin/sh` runs the production probe command string, so the
 * start line under test is the one `probeShellCommand` writes, without loading a profile.
 */

import { afterEach, expect, test } from "vitest";
import {
  resetProbeTimeoutForTests,
  runProbe,
  setProbeTimeoutMsForTests,
} from "../../src/runtime/probe.ts";
import { probeShellCommand } from "../../src/runtime/shell.ts";

/** A probe shell whose "profile" takes `profile` before the production probe command runs. */
function probe(profile: string, command: string) {
  return runProbe("/bin/sh", ["-c", `${profile}; ${probeShellCommand(command).at(-1)}`]);
}

afterEach(() => resetProbeTimeoutForTests());

test("C-PERF-05 a profile slower than the command bound does not fail a fast command", async () => {
  setProbeTimeoutMsForTests(150, 10_000);
  const result = await probe("sleep 0.6", "echo 2.1.310");
  expect(result).toEqual({ status: 0, stdout: "2.1.310\n", stderr: "" });
});

test("C-PERF-05 a shell that never writes the start line is killed at the launch bound", async () => {
  setProbeTimeoutMsForTests(10_000, 150);
  const result = await runProbe("/bin/sh", ["-c", "echo profile-noise >&2; sleep 30"]);
  expect(result.status).toBeNull();
  expect(result.stderr).toBe("profile-noise\n");
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(result.error?.message).toBe("login shell did not start the probe command within 150 ms");
});

test("C-PERF-03 the command bound starts at the start line and still kills a hung command", async () => {
  setProbeTimeoutMsForTests(150, 10_000);
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
