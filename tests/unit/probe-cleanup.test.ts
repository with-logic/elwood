/** Bounded fallback termination and retained probe ownership (PRD §9.2, C-PERF-03). */
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { abortProbe, processGroupGone } from "../../src/runtime/probe-cleanup.ts";

const kill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());

test("C-PERF-03 a group signal failure falls back to the child and waits for its exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  expect(processGroupGone(child.pid!)).toBe(false);
  let attempts = 0;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGKILL" && attempts++ === 0) {
      throw Object.assign(new Error("private"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  const result = await abortProbe(child);
  expect(result).toEqual({ cleanupErrorCode: "EPERM" });
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
