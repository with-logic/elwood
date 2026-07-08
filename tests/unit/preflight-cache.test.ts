/**
 * Version-read cache and async-non-blocking preflight tests.
 * Covers PRD §9.2 and C-PERF-01, C-PERF-02.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
} from "../../src/runtime/update-once.ts";

function resetPreflight(): void {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
}

describe("version-read cache", () => {
  beforeEach(resetPreflight);

  test("C-PERF-01 concurrent adapter preflights overlap instead of serializing", async () => {
    setPlatformForTests("darwin");
    // Deterministic overlap proof: track how many reads are in flight at once.
    // A synchronous (serializing) runner would never exceed 1; an async one
    // that overlaps reaches 2 when both adapters' reads are pending together.
    let inFlight = 0;
    let maxInFlight = 0;
    setCommandRunnerForTests((_command, args) => {
      const stdout = args.join(" ").includes("codex") ? "codex-cli 0.132.0" : "2.1.144";
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve({ status: 0, stdout, stderr: "" });
        }, 5);
      });
    });
    await Promise.all([preflightClaude(false), preflightCodex(false)]);
    expect(maxInFlight).toBe(2);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-02 reads --version at most once per process", async () => {
    let reads = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => {
      reads += 1;
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false);
    await preflightClaude(true);
    expect(reads).toBe(1);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-02 concurrent first reads share one subprocess", async () => {
    let reads = 0;
    setPlatformForTests("darwin");
    setCommandRunnerForTests(
      () =>
        new Promise((resolve) => {
          reads += 1;
          setTimeout(() => resolve({ status: 0, stdout: "2.1.144", stderr: "" }), 5);
        }),
    );
    await Promise.all([preflightClaude(false), preflightClaude(false), preflightClaude(false)]);
    expect(reads).toBe(1);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-02 autoupdate invalidates the cache so the version is re-read", async () => {
    const versions: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      versions.push("read");
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false, true);
    // One read before the update, one after the invalidate.
    expect(versions).toHaveLength(2);
    resetRuntimeSeamsForTests();
  });
});
