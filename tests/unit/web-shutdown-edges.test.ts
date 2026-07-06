/**
 * Edge coverage for web dev app hard shutdown defaults and reentrancy.
 * Covers PRD §11 (C-APP-08).
 */

import { describe, expect, test } from "vitest";
import { installHardShutdown, runShutdown } from "../../src/app/web-shutdown.ts";

const watchedEvents = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "exit",
] as const;

describe("web dev app shutdown edges", () => {
  test("C-APP-08 installs handlers on the real process by default", () => {
    const before = new Map(
      watchedEvents.map((event) => [event, new Set(process.listeners(event as "exit"))]),
    );
    installHardShutdown();
    let added = 0;
    for (const event of watchedEvents) {
      for (const listener of process.listeners(event as "exit")) {
        if (before.get(event)?.has(listener)) continue;
        added += 1;
        process.removeListener(event as "exit", listener);
      }
    }
    expect(added).toBe(watchedEvents.length);
  });

  test("C-APP-08 repeated shutdown signals force an immediate kill", () => {
    const processLike = new FakeProcess(1234);
    const killTreeCalls: [number, boolean][] = [];
    installHardShutdown({
      processLike,
      killTree: (pid, includeRoot) => killTreeCalls.push([pid, includeRoot]),
      cleanup: () => new Promise(() => undefined),
      hardKillMs: 60_000,
    });
    processLike.handlers.get("SIGTERM")?.();
    expect(() => processLike.handlers.get("SIGTERM")?.()).toThrow("exit 137");
    expect(processLike.kills).toEqual([{ pid: 1234, signal: "SIGKILL" }]);
    expect(killTreeCalls).toContainEqual([1234, false]);
  });

  test("C-APP-08 runShutdown defaults to the real process-tree killer", async () => {
    const processLike = new FakeProcess(999_999_999);
    await expect(runShutdown({ processLike, cleanup: () => undefined, code: 5 })).rejects.toThrow(
      "exit 5",
    );
    expect(processLike.exitCode).toBe(5);
  });
});

class FakeProcess {
  readonly pid: number;
  readonly handlers = new Map<string, () => void>();
  readonly kills: { readonly pid: number; readonly signal: string }[] = [];
  exitCode = 0;

  constructor(pid: number) {
    this.pid = pid;
  }

  on(signal: string, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  kill(pid: number, signal: "SIGKILL"): void {
    this.kills.push({ pid, signal });
  }

  exit(code: number): never {
    this.exitCode = code;
    throw new Error(`exit ${code}`);
  }
}
