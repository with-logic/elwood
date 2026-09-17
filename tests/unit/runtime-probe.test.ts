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
    setProbeTimeoutMsForTests(100);
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
    const signaled: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      signaled.push(pid);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const result = await runProbe(node, ["-e", "setTimeout(() => {}, 300)"]);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(signaled).toHaveLength(1);
    expect(signaled[0]).toBeLessThan(0); // the process GROUP, not just the child pid
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
