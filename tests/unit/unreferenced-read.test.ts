/** Nullable execFile pipes and setup failures never leave an unhandled read (C-LIFE-14). */
import { ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import {
  runFileUnreferenced,
  settleUnreferenced,
} from "../../src/runtime/shutdown/unreferenced-read.ts";

test("C-LIFE-14 a spawn failure with absent pipes rejects as the original read error", async () => {
  const child = Object.assign(new ChildProcess(), { stdout: null, stderr: null });
  expect(child.stdout).toBeNull();
  expect(child.stderr).toBeNull();
  const error = Object.assign(new Error("spawn failed"), { code: "EAGAIN" });
  const running = Object.assign(Promise.reject(error), { child });
  await expect(settleUnreferenced(running, 1_000, "SIGKILL")).rejects.toBe(error);
  await new Promise((resolve) => setImmediate(resolve));
});

test("C-LIFE-14 a setup exception also observes an already rejected read promise", async () => {
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

test("C-LIFE-14 a real missing process reports its spawn errno without an unhandled rejection", async () => {
  await expect(
    runFileUnreferenced("/elwood-no-such-ps", [], {
      timeout: 100,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
      env: {},
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("C-LIFE-14 setup failure after a real spawn ends only that owned child", async () => {
  const running = promisify(execFile)("/bin/sleep", ["30"]);
  vi.spyOn(running.child, "unref").mockImplementation(() => {
    throw new Error("setup failed");
  });
  await expect(settleUnreferenced(running, 1_000, "SIGKILL")).rejects.toThrow("setup failed");
  expect(running.child.signalCode).toBe("SIGKILL");
});
