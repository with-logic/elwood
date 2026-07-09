/**
 * Focused coverage for web dev app hard shutdown.
 * Covers PRD §11.
 */

import { spawn, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  installHardShutdown,
  killProcessTreeSync,
  runShutdown,
} from "../../src/app/web-shutdown.ts";

describe("web dev app hard shutdown", () => {
  test("C-APP-08 registers exit and job-control signals without reading stdin", async () => {
    const process = new FakeProcess();
    const cleaned: string[] = [];
    const killTreeCalls: [number, boolean][] = [];
    installHardShutdown({
      processLike: process,
      killTree: (pid, includeRoot) => killTreeCalls.push([pid, includeRoot]),
      cleanup: () => {
        cleaned.push("async");
      },
      cleanupSync: () => {
        cleaned.push("sync");
      },
    });
    expect([...process.handlers.keys()]).toEqual([
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "SIGTSTP",
      "SIGTTIN",
      "SIGTTOU",
      "exit",
    ]);
    expect(() => process.handlers.get("SIGINT")?.()).toThrow("exit 137");
    expect(process.kills).toEqual([{ pid: 1234, signal: "SIGKILL" }]);
    expect(cleaned).toEqual([]);
    const ttyProcess = new FakeProcess();
    installHardShutdown({
      processLike: ttyProcess,
      killTree: (pid, includeRoot) => killTreeCalls.push([pid, includeRoot]),
      cleanup: () => {
        cleaned.push("async");
      },
      cleanupSync: () => {
        cleaned.push("sync");
      },
    });
    ttyProcess.handlers.get("SIGTTIN")?.();
    await ttyProcess.exited;
    ttyProcess.handlers.get("exit")?.();
    expect(ttyProcess.exitCode).toBe(130);
    expect(cleaned).toEqual(["async", "sync"]);
    expect(killTreeCalls).toContainEqual([1234, false]);
  });

  test("C-APP-08 exits with signal-specific codes", async () => {
    const termProcess = new FakeProcess();
    installHardShutdown({ processLike: termProcess, killTree: () => undefined });
    termProcess.handlers.get("SIGTERM")?.();
    await termProcess.exited;
    termProcess.handlers.get("exit")?.();
    expect(termProcess.exitCode).toBe(143);
    const hupProcess = new FakeProcess();
    installHardShutdown({ processLike: hupProcess, killTree: () => undefined });
    hupProcess.handlers.get("SIGHUP")?.();
    await hupProcess.exited;
    expect(hupProcess.exitCode).toBe(129);
    const onceProcess = new FakeOnceProcess();
    installHardShutdown({ processLike: onceProcess, killTree: () => undefined });
    expect(onceProcess.handlers.has("SIGINT")).toBe(true);
  });

  test("C-APP-08 hard-kill fallback fires when cleanup hangs", async () => {
    const process = new FakeProcess();
    const killTreeCalls: [number, boolean][] = [];
    void runShutdown({
      processLike: process,
      cleanup: () => new Promise(() => undefined),
      code: 143,
      hardKillMs: 1,
      killTree: (pid, includeRoot) => killTreeCalls.push([pid, includeRoot]),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(killTreeCalls).toEqual([[1234, false]]);
    expect(process.kills).toEqual([{ pid: 1234, signal: "SIGKILL" }]);
  });

  test("C-APP-08 process tree cleanup kills real descendants", async () => {
    const child = spawn("sh", ["-c", "sleep 10 & wait"], { stdio: "ignore" });
    expect(typeof child.pid).toBe("number");
    await waitForChild(child.pid!);
    killProcessTreeSync(child.pid!, true);
    const result = await new Promise<{ readonly signal: string | null }>((resolve) => {
      child.once("exit", (_code, signal) => resolve({ signal }));
    });
    expect(result.signal).toBe("SIGKILL");
    killProcessTreeSync(999_999_999, true);
  });

  test("C-APP-08 does not group-signal the caller's own process group", () => {
    // Passing our own pid must skip the negative-pid group kill (which would
    // signal this test runner) and, with includeRoot=false, do nothing at all.
    expect(() => killProcessTreeSync(process.pid, false)).not.toThrow();
  });
});

async function waitForChild(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spawnSync("pgrep", ["-P", String(pid)]).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeProcess {
  readonly pid = 1234;
  readonly handlers = new Map<string, () => void>();
  readonly kills: { readonly pid: number; readonly signal: string }[] = [];
  exitCode = 0;
  private resolveExit: (() => void) | undefined;
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  on(signal: string, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  kill(pid: number, signal: "SIGKILL"): void {
    this.kills.push({ pid, signal });
  }

  exit(code: number): never {
    this.exitCode = code;
    this.resolveExit?.();
    throw new Error(`exit ${code}`);
  }
}

class FakeOnceProcess {
  readonly pid = 1234;
  readonly handlers = new Map<string, () => void>();

  once(signal: string, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  kill(): void {}

  exit(): never {
    throw new Error("exit");
  }
}
