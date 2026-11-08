/** Nullable execFile pipes and setup failures never leave an unhandled read (C-LIFE-10). */
import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import {
  runFileUnreferenced,
  settleUnreferenced,
} from "../../src/runtime/shutdown/unreferenced-read.ts";

test("C-LIFE-10 a spawn failure with absent pipes rejects as the original read error", async () => {
  const child = Object.assign(new ChildProcess(), { stdout: null, stderr: null });
  expect(child.stdout).toBeNull();
  expect(child.stderr).toBeNull();
  const error = Object.assign(new Error("spawn failed"), { code: "EAGAIN" });
  const running = Object.assign(Promise.reject(error), { child });
  await expect(settleUnreferenced(running, 1_000, "SIGKILL")).rejects.toBe(error);
  await new Promise((resolve) => setImmediate(resolve));
});

test("C-LIFE-10 a setup exception also observes an already rejected read promise", async () => {
  const child = Object.assign(new ChildProcess(), { stdout: null, stderr: null });
  vi.spyOn(child, "unref").mockImplementation(() => {
    throw new Error("setup failed");
  });
  const killed = vi.spyOn(child, "kill");
  const running = Object.assign(Promise.reject(new Error("read failed")), { child });
  await expect(settleUnreferenced(running, 1_000, "SIGKILL")).rejects.toThrow("setup failed");
  expect(killed).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
});

test("C-LIFE-10 a real missing process reports its spawn errno without an unhandled rejection", async () => {
  await expect(
    runFileUnreferenced("/elwood-no-such-ps", [], {
      timeout: 100,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
      env: {},
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("C-LIFE-10 setup failure after a real spawn ends only that owned child", async () => {
  const running = promisify(execFile)("/bin/sleep", ["30"]);
  vi.spyOn(running.child, "unref").mockImplementation(() => {
    throw new Error("setup failed");
  });
  const started = performance.now();
  await expect(settleUnreferenced(running, 1_000, "SIGKILL")).rejects.toThrow("setup failed");
  expect(performance.now() - started).toBeLessThan(500);
  expect(running.child.signalCode).toBe("SIGKILL");
});

test("C-LIFE-10 an unreferenced read still kills its owned child at its timeout", async () => {
  await expect(
    runFileUnreferenced("/bin/sleep", ["5"], {
      timeout: 20,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
      env: {},
    }),
  ).rejects.toMatchObject({ signal: "SIGKILL" });
});

test("C-LIFE-10 unreferenced readers coalesce only reads not yet started", async () => {
  const { createUnreferencedProcessTableReader } = await import(
    "../../src/runtime/shutdown/unreferenced-read.ts"
  );
  const native = vi.fn(() => Promise.resolve({ stdout: "" }));
  const read = createUnreferencedProcessTableReader(native);
  // Batching is under test; leave room for scheduling on a loaded host.
  const readBudgetMs = 5_000;
  await expect(Promise.all([read(readBudgetMs), read(readBudgetMs)])).resolves.toEqual([[], []]);
  expect(native).toHaveBeenCalledOnce();
  await expect(read(readBudgetMs)).resolves.toEqual([]);
  expect(native).toHaveBeenCalledTimes(2);
});

test("C-LIFE-10 internal unreferenced operations read the real process table", async () => {
  const { osProcessTreeOps } = await import("../../src/runtime/shutdown/process-tree-ops.ts");
  const table = await osProcessTreeOps.listProcessesUnreferenced?.(5000);
  expect(table?.some((row) => row.pid === process.pid)).toBe(true);
});
