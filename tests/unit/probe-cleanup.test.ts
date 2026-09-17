/** Bounded fallback termination and retained probe ownership (PRD §9.2, C-PERF-03). */
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { abortProbe, processGroupGone } from "../../src/runtime/probe-cleanup.ts";

const kill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());

test("C-PERF-03 persistent group signal failure falls back to the child and reports confirmed cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  expect(processGroupGone(child.pid!)).toBe(false);
  let attempts = 0;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== "SIGKILL") return kill(pid, signal);
    attempts += 1;
    throw Object.assign(new Error("private"), { code: "EPERM" });
  });
  const started = Date.now();
  // Cleanup confirmed through the fallback is not a cleanup failure.
  expect(await abortProbe(child)).toEqual({});
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(attempts).toBeGreaterThan(1);
  expect(child.signalCode).toBe("SIGKILL");
  expect(processGroupGone(child.pid!)).toBe(true);
});

test("C-PERF-03 an unconfirmed group is returned after the bounded cleanup window", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    const result = await abortProbe(child);
    expect(result).toEqual({ cleanupErrorCode: "ETIMEDOUT", cleanupProcessGroup: child.pid });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    kill(-child.pid!, "SIGKILL");
  }
});

test("C-PERF-03 a group disappearing between liveness and signal needs no retry", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGKILL") {
      kill(pid, signal);
      throw Object.assign(new Error("exited concurrently"), { code: "ESRCH" });
    }
    return kill(pid, signal);
  });
  await expect(abortProbe(child)).resolves.toEqual({});
});
