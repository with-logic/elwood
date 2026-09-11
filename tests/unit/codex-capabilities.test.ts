/**
 * Codex capability detection and bounded-probe failure surfacing.
 * Covers PRD §9.2, C-CODEX-06, C-PERF-02, and C-PERF-03.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

afterEach(() => {
  resetCodexPreflightCacheForTests();
  resetRuntimeSeamsForTests();
});

describe("Codex capability detection", () => {
  test("C-CODEX-06 detects hook trust bypass support from login shell help", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "codex-cli 0.133.0", stderr: "" },
    );
    expect((await detectCodexCliCapabilities()).supportsHookTrustBypass).toBe(true);
    resetCodexPreflightCacheForTests();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "codex help", stderr: "" }));
    expect((await detectCodexCliCapabilities()).supportsHookTrustBypass).toBe(false);
  });

  test("C-PERF-02 concurrent first capability probes share one subprocess", async () => {
    setPlatformForTests("darwin");
    let helpReads = 0;
    setCommandRunnerForTests(
      () =>
        new Promise((resolve) => {
          helpReads += 1;
          setTimeout(() => resolve({ status: 0, stdout: "codex help", stderr: "" }), 5);
        }),
    );
    await Promise.all([
      detectCodexCliCapabilities(),
      detectCodexCliCapabilities(),
      detectCodexCliCapabilities(),
    ]);
    expect(helpReads).toBe(1);
  });

  test("C-PERF-02 a settled autoupdate does not repeatedly evict capabilities", async () => {
    let helpReads = 0;
    let updates = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      const command = args.join(" ");
      if (command.includes("--help")) {
        helpReads += 1;
        return { status: 0, stdout: "codex help", stderr: "" };
      }
      if (command.includes("codex update")) updates += 1;
      return { status: 0, stdout: "codex-cli 0.132.0", stderr: "" };
    });
    await detectCodexCliCapabilities();
    await preflightCodex(false, true);
    await detectCodexCliCapabilities();
    await preflightCodex(false, true);
    await detectCodexCliCapabilities();
    expect({ helpReads, updates }).toEqual({ helpReads: 2, updates: 1 });
  });

  test("C-LIFE-11 a failed autoupdate also evicts stale capabilities", async () => {
    let helpReads = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      const command = args.join(" ");
      if (command.includes("--help")) {
        helpReads += 1;
        return { status: 0, stdout: "codex help", stderr: "" };
      }
      return command.includes("codex update")
        ? { status: 1, stdout: "", stderr: "partially replaced" }
        : { status: 0, stdout: "codex-cli 0.132.0", stderr: "" };
    });
    await detectCodexCliCapabilities();
    await expect(preflightCodex(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
    });
    await detectCodexCliCapabilities();
    expect(helpReads).toBe(2);
  });

  test("C-PERF-03 a bounded --help probe fails as codex_start_failed with cause", async () => {
    setPlatformForTests("darwin");
    // A timed-out/overflowed `codex --help` is a diagnosable startup failure,
    // not "capability unsupported".
    for (const error of [
      { code: "ETIMEDOUT", message: "probe timed out after 15000 ms" },
      { code: "E2BIG", message: "probe output exceeded 1000000 bytes" },
    ]) {
      resetCodexPreflightCacheForTests();
      setCommandRunnerForTests(() => ({ status: null, stdout: "", stderr: "", error }));
      await expect(detectCodexCliCapabilities()).rejects.toMatchObject({
        code: "codex_start_failed",
        details: { cause: error.message, errno: error.code },
      });
    }
  });

  test("C-PERF-03 a bounded codex update probe is best-effort: warns with errno, not fatal", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("codex update")
        ? {
            status: null,
            stdout: "",
            stderr: "",
            error: { code: "ETIMEDOUT", message: "probe timed out after 15000 ms" },
          }
        : { status: 0, stdout: "codex-cli 0.132.0", stderr: "" },
    );
    // The bounded update is contained: the installed 0.132.0 is compatible, so preflight resolves
    // with the `agent_update_failed` warning carrying the timeout errno — never a start failure.
    await expect(preflightCodex(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
      errorCode: "ETIMEDOUT",
      installedVersion: "0.132.0",
    });
  });
});
