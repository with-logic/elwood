/**
 * Real-subprocess coverage for the bounded probe runner behind the command-runner
 * seam. Covers PRD §9.2 and C-PERF-01/C-PERF-03: async, bounded by time and bytes,
 * killed as a whole process group, and never signaled on a clean exit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { currentCommandRunner } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";

const node = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

afterEach(() => vi.restoreAllMocks());

describe("runtime probe runner", () => {
  test("the production command runner IS the bounded probe", () => {
    expect(currentCommandRunner()).toBe(runProbe);
  });

  test("reports spawn failures for missing commands", async () => {
    const result = await runProbe("elwood-missing-command-for-tests", ["--version"]);
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error?.code).toBe("ENOENT");
  });

  test("captures stdout, stderr, and a non-zero exit", async () => {
    const result = await runProbe(node, [
      "-e",
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
    ]);
    expect(result).toEqual({ status: 3, stdout: "out", stderr: "err" });
  });

  test("C-PERF-01 the runner is async — the loop advances before it resolves", async () => {
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    const pending = runProbe(node, ["-e", "setTimeout(() => {}, 15)"]);
    // If the runner blocked the loop the macrotask above could not have run yet.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
    await pending;
  });

  test("C-PERF-03 a hung probe is killed at the timeout with a typed error", async () => {
    setProbeTimeoutMsForTests(50);
    const result = await runProbe(node, ["-e", "setInterval(() => {}, 1000)"]);
    expect(result.status).toBeNull();
    expect(result.error?.code).toBe("ETIMEDOUT");
  });

  test("C-PERF-03 a timed-out probe kills its whole process group, not just the shell", async () => {
    // The shell backgrounds a grandchild (as `claude update` may spawn an installer)
    // and then hangs. Killing only the shell would leave the grandchild alive AND
    // holding the probe's stdio pipes open, pinning the host event loop for 30s.
    // Generous, because the probe must not time out until the shell has recorded the
    // grandchild: at a short timeout a loaded machine aborts before `echo` ever runs, and
    // the test then fails for want of a marker rather than for a surviving grandchild.
    setProbeTimeoutMsForTests(2_000);
    const marker = join(tempDir("elwood-probe-"), "grandchild.pid");
    const result = await runProbe("/bin/sh", ["-c", `sleep 30 & echo $! > "${marker}"; wait`]);
    expect(result.error?.code).toBe("ETIMEDOUT");
    const grandchild = Number(readFileSync(marker, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await pollGone(grandchild)).toBe(true);
  });

  test("C-PERF-03 a probe whose group already exited at abort time still settles (ESRCH)", async () => {
    // The child can exit in the instant between the timer firing and the group kill;
    // the kill's ESRCH is swallowed and the timed-out result still resolves. The child
    // here exits on its own shortly after, since the stubbed kill never signals it.
    setProbeTimeoutMsForTests(50);
    // Signal and target both recorded: `ESRCH` from the signal-0 observation means the
    // group is already gone, and the point of the test is that abort then stops. Recording
    // only pids could not tell that apart from a SIGKILL that also happened to see ESRCH.
    const signaled: { target: number; signal: string | number | undefined }[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signaled.push({ target: pid, signal });
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const result = await runProbe(node, ["-e", "setTimeout(() => {}, 300)"]);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(signaled[0]).toEqual({ target: expect.any(Number), signal: 0 });
    expect(signaled[0]?.target).toBeLessThan(0); // the process GROUP, not just the child pid
    // Nothing was ever actually signaled: a group observed gone is not killed again.
    expect(signaled.every((call) => call.signal === 0)).toBe(true);
  });

  test.each([
    "EPERM",
    "unexpected",
  ])("C-PERF-03 abort failure %s still settles without leaking error text", async (code) => {
    setProbeTimeoutMsForTests(25);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("private probe context"), { code, name: "PrivateError" });
    });
    const result = await runProbe(node, ["-e", "setTimeout(() => {}, 100)"]);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.error?.cleanupErrorCode).toBe(code === "EPERM" ? "EPERM" : "UnknownError");
    expect(result.error?.cleanupProcessGroupId).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("private probe context");
  });

  test("C-PERF-03 a stdout-flooding probe is capped and killed with a typed error", async () => {
    const result = await runProbe(node, [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000_000);
  });

  test("C-PERF-03 a stderr-flooding probe is capped and killed with a typed error", async () => {
    const result = await runProbe(node, [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stderr.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_000_000);
  });

  test("C-PERF-03 the output cap is enforced by bytes on a code-point boundary", async () => {
    // Each `€` is 3 bytes: a decoded-LENGTH cap would keep ~3e6 bytes. Truncation
    // drops an incomplete trailing code point, so the string re-encodes to at most
    // the cap with no replacement character.
    const result = await runProbe(node, [
      "-e",
      "const b = '\\u20ac'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(result.stdout.length).toBeLessThan(400_000);
    expect(result.stdout).not.toContain("�");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000_000);
  });

  test("C-PERF-03 a normal probe exit is not signaled", async () => {
    const result = await runProbe(node, ["-e", "process.exit(0)"]);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
  });
});
