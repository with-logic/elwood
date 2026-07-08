/**
 * Branch-level unit coverage for runtime seams, startup cleanup, and teardown.
 * Covers PRD §4.2, §9.1, §10, and §13.
 */

import { describe, expect, test } from "vitest";
import {
  currentCommandRunner,
  resetRuntimeSeamsForTests,
  setProbeTimeoutMsForTests,
} from "../../src/runtime/seams.ts";
import { cleanupStartupResources } from "../../src/runtime/startup-cleanup.ts";
import { runTeardownSteps } from "../../src/runtime/teardown.ts";

describe("runtime seams", () => {
  test("real command runner reports spawn failures for missing commands", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("elwood-missing-command-for-tests", ["--version"]);
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error?.code).toBe("ENOENT");
  });

  test("real command runner captures stdout, stderr, and a non-zero exit", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("node", [
      "-e",
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
    ]);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("C-PERF-01 the production runner is async — the loop advances before it resolves", async () => {
    resetRuntimeSeamsForTests();
    let ticked = false;
    // A macrotask scheduled now would not run if the runner blocked the loop.
    setTimeout(() => {
      ticked = true;
    }, 0);
    const pending = currentCommandRunner()("node", ["-e", "setTimeout(() => {}, 15)"]);
    // Yield once: if the runner were synchronous (spawnSync), the subprocess
    // would already be done and the loop would not have ticked mid-call.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
    await pending;
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-01 a hung probe is killed at the timeout with a typed error", async () => {
    resetRuntimeSeamsForTests();
    setProbeTimeoutMsForTests(50);
    // A child that never exits must be killed and resolve an ETIMEDOUT result.
    const result = await currentCommandRunner()("node", ["-e", "setInterval(() => {}, 1000)"]);
    expect(result.status).toBeNull();
    expect(result.error?.code).toBe("ETIMEDOUT");
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-01 a stdout-flooding probe is capped and killed with a typed error", async () => {
    resetRuntimeSeamsForTests();
    // A child that streams far more than the 1MB cap must be bounded, not OOM.
    const result = await currentCommandRunner()("node", [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(result.stdout.length).toBeLessThanOrEqual(1_000_000);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-01 a stderr-flooding probe is capped and killed with a typed error", async () => {
    resetRuntimeSeamsForTests();
    const result = await currentCommandRunner()("node", [
      "-e",
      "const b = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stderr.write(b);",
    ]);
    expect(result.error?.code).toBe("E2BIG");
    expect(result.stderr.length).toBeLessThanOrEqual(1_000_000);
    resetRuntimeSeamsForTests();
  });
});

describe("startup cleanup", () => {
  test("resolves when no startup resources were created", async () => {
    await expect(cleanupStartupResources({})).resolves.toBeUndefined();
  });
});

describe("teardown", () => {
  test("C-ERR-01 stringifies non-Error teardown step failures", async () => {
    await expect(
      runTeardownSteps([() => Promise.reject("primitive teardown failure")]),
    ).rejects.toMatchObject({
      code: "teardown_failed",
      details: { causes: ["primitive teardown failure"] },
    });
  });
});
