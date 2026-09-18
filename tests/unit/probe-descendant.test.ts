/** Group signals reach real descendants only while the leader pins the id (PRD §9.2). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { processGroupGone } from "../../src/runtime/probe-cleanup.ts";
import { tempDir } from "../helpers/tmp.ts";

const fixture = fileURLToPath(new URL("../fixtures/probe-descendant.ts", import.meta.url));
const kill = process.kill.bind(process);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["ELWOOD_PROBE_FIXTURE_ROOT"];
});
function cleanup(root: string): void {
  if (!existsSync(join(root, "leader"))) return;
  const pid = Number(readFileSync(join(root, "leader"), "utf8"));
  try {
    kill(-pid, "SIGKILL");
  } catch {}
}

// SIGKILLs aimed at a process group, with whether its leader was already reaped.
function denyGroupSignals(allow: () => boolean) {
  const attempts: { readonly leaderReaped: boolean }[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid >= 0 || signal !== "SIGKILL") return kill(pid, signal);
    let leaderReaped = false;
    try {
      kill(-pid, 0);
    } catch {
      leaderReaped = true;
    }
    attempts.push({ leaderReaped });
    if (!allow()) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  return attempts;
}

test("C-PERF-03 a reaped leader's group id is only observed, never signaled as a bare number", async () => {
  const root = tempDir("elwood-probe-reaper-");
  // Through the environment, not argv: the probe below runs behind a `/bin/sh -c` gate,
  // and a path passed as an argument there is a command-injection sink.
  process.env["ELWOOD_PROBE_FIXTURE_ROOT"] = root;
  setProbeTimeoutMsForTests(1_500);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const cleared = vi.spyOn(globalThis, "clearInterval");
  let allowGroupSignal = false;
  const attempts = denyGroupSignals(() => allowGroupSignal);
  try {
    const result = await runProbe(process.execPath, ["--no-warnings", fixture, "linger"]);
    expect(result.error).toMatchObject({ code: "ETIMEDOUT", cleanupErrorCode: "EPERM" });
    const group = Number(readFileSync(join(root, "leader"), "utf8"));
    expect(result.error?.cleanupProcessGroupId).toBe(group);
    // The direct-child fallback reaped the leader; its descendant still holds the id.
    expect(() => kill(group, 0)).toThrow();
    const timer = intervals.mock.results.at(-1)?.value;
    expect(timer.hasRef()).toBe(false);
    // Once the leader is reaped the number could name a recycled, unrelated group,
    // so even a now-permitted signal must not be sent across retained retries.
    allowGroupSignal = true;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.filter((attempt) => attempt.leaderReaped)).toEqual([]);
    expect(processGroupGone(group)).toBe(false);
    kill(Number(readFileSync(join(root, "descendant"), "utf8")), "SIGKILL");
    await expect
      .poll(() => cleared.mock.calls.some(([value]) => value === timer), { timeout: 3_000 })
      .toBe(true);
  } finally {
    cleanup(root);
  }
});

test("C-PERF-03 group retries reach real descendants while the unreaped leader pins the id", async () => {
  const root = tempDir("elwood-probe-retry-");
  process.env["ELWOOD_PROBE_FIXTURE_ROOT"] = root;
  setProbeTimeoutMsForTests(1_500);
  const attempts = denyGroupSignals(() => attempts.length > 3);
  try {
    const result = await runProbe(process.execPath, ["--no-warnings", fixture, "linger"]);
    expect(result.error).toEqual({ code: "ETIMEDOUT", message: expect.any(String) });
    expect(attempts).toHaveLength(4);
    expect(processGroupGone(Number(readFileSync(join(root, "leader"), "utf8")))).toBe(true);
  } finally {
    cleanup(root);
  }
});
