/**
 * Branch-level unit coverage for runtime seams, startup cleanup, and teardown.
 * Covers PRD §4.2, §9.1, §10, and §13.
 */

import { describe, expect, test } from "vitest";
import { currentCommandRunner, resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanupStartupResources } from "../../src/runtime/startup-cleanup.ts";
import { runTeardownSteps } from "../../src/runtime/teardown.ts";

describe("runtime seams", () => {
  test("real command runner reports spawn failures for missing commands", () => {
    resetRuntimeSeamsForTests();
    const result = currentCommandRunner()("elwood-missing-command-for-tests", ["--version"]);
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error?.code).toBe("ENOENT");
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
