/** Bounded fallback termination and retained probe ownership (PRD §9.2, C-PERF-03). */
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
    expect(result).toEqual({ cleanupErrorCode: "ETIMEDOUT", cleanupProcessGroupId: child.pid });
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

test("C-PERF-03 a group that exits during the final wait is confirmed, not reported unresolved", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  const started = performance.now();
  // Signals are swallowed; the group reads as gone only once the cleanup window has elapsed.
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0 && performance.now() - started >= 1_000)
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  try {
    expect(await abortProbe(child)).toEqual({});
  } finally {
    kill(-child.pid!, "SIGKILL");
  }
});

// Defence in depth rather than a regression guard: with group kills denied, the child
// fallback latches `signalCode` at the group-only threshold, and `leaderReaped` then
// short-circuits every later `reap` before it can signal. This asserts the outcome the
// deadline check also guarantees, so it passes with or without that check.
test("C-PERF-03 a successfully signaled group is never signaled twice", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  // The group stays live after a "successful" kill, so a reaper that failed to latch would
  // signal it again on the next retained tick — and by then the id may name someone else.
  const groupKills: number[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGKILL" && pid < 0) groupKills.push(pid);
    return true;
  });
  try {
    expect(await abortProbe(child)).toMatchObject({ cleanupProcessGroupId: child.pid });
    const afterWindow = groupKills.length;
    expect(afterWindow).toBe(1);
    // A retained reaper keeps polling; the latch is what stops it signaling again.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(groupKills.length).toBe(afterWindow);
  } finally {
    vi.restoreAllMocks();
    try {
      kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});

test("C-PERF-03 nothing is signaled after the cleanup deadline, even a still-live group", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  const started = performance.now();
  // The group stays live throughout AND every group SIGKILL fails with EPERM, which is
  // what keeps `reap` willing to signal again: a kill that succeeds latches `signaled` and
  // would never retry, so a mock that lets the first one through cannot observe a late one.
  const late: (string | number)[] = [];
  const record = (signal: NodeJS.Signals | number | undefined | string) => {
    if (performance.now() - started >= 1_000 && signal !== 0) late.push(signal ?? "default");
  };
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    record(signal);
    if (signal === 0) return true; // observation: the group is always live here
    if (pid < 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return true;
  });
  // The direct-child fallback goes through the handle, not `process.kill`, so it has to be
  // recorded separately or a late child signal would not be seen at all.
  vi.spyOn(child, "kill").mockImplementation((signal) => {
    record(signal);
    return true;
  });
  try {
    // Unresolved by construction, because the group never reads as gone; EPERM rather
    // than ETIMEDOUT because the denied group kill is the reason cleanup could not finish.
    expect(await abortProbe(child)).toMatchObject({
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: child.pid,
    });
    expect(late).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    // The real child-fallback SIGKILL above is allowed through, so the group may already
    // be gone; a failed assertion must not be masked by this cleanup finding that.
    try {
      kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});

test("C-PERF-03 an unresolved cleanup window does not keep the host process alive", async () => {
  const cleanup = pathToFileURL(
    fileURLToPath(new URL("../../src/runtime/probe-cleanup.ts", import.meta.url)),
  ).href;
  // A real host whose group signals are swallowed: with nothing else to do it must exit
  // while the cleanup window is still open, leaving `abortProbe` unresolved.
  const host = `
    import { spawn } from "node:child_process";
    const { abortProbe } = await import(${JSON.stringify(cleanup)});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true });
    await new Promise((resolve) => child.once("spawn", resolve));
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => (signal === "SIGKILL" ? true : kill(pid, signal));
    process.on("exit", () => kill(-child.pid, "SIGKILL"));
    let cleanup = "pending";
    process.on("exit", () => console.log(cleanup));
    void abortProbe(child).then(() => (cleanup = "resolved"));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", host],
    { timeout: 10_000 },
  );
  expect(stdout.trim()).toBe("pending");
});
