/** Native fallback errors stay contained after output-abort settlement (PRD §9.2, C-PERF-03). */
import { ChildProcess } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";

const nativeKill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());

function killOwnedGroup(pid: number): void {
  try {
    nativeKill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

test("C-PERF-03 a native kill EPERM after abort is contained and reported within the cleanup bound", async () => {
  let errors = 0;
  vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess) {
    errors += 1;
    this.emit("error", Object.assign(new Error("native kill EPERM"), { code: "EPERM" }));
    return false;
  });
  let ownedPid: number | undefined;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== "SIGKILL") return nativeKill(pid, signal);
    ownedPid = -pid;
    throw Object.assign(new Error("group EPERM"), { code: "EPERM" });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = runProbe(process.execPath, [
      "-e",
      'process.stdout.on("error", () => {}); process.stdout.write("x".repeat(2_000_000)); setInterval(() => {}, 1000)',
    ]);
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("probe cleanup did not deliver its result")),
          3_000,
        );
      }),
    ]);
    expect(result.error).toMatchObject({ code: "E2BIG", cleanupErrorCode: "EPERM" });
    expect(errors).toBeGreaterThan(0);
  } finally {
    clearTimeout(timer);
    if (ownedPid !== undefined) killOwnedGroup(ownedPid);
  }
});
