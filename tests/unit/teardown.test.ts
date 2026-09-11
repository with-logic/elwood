/**
 * Attempt-all sequencing for owned runtime resources: `runTeardownSteps` (PRD §8.4,
 * §10 `teardown_failed`, C-STATE-09, C-ERR-01) and the §9.4 `runCleanupSteps`
 * primitive every exit path shares.
 */

import { describe, expect, test } from "vitest";
import { runCleanupSteps, runTeardownSteps } from "../../src/runtime/shutdown/teardown.ts";

describe("runTeardownSteps", () => {
  test("C-STATE-09 attempts every cleanup step before throwing teardown_failed", async () => {
    const calls: string[] = [];
    await expect(
      runTeardownSteps([
        () => {
          calls.push("first");
          throw new Error("first failed");
        },
        () => {
          calls.push("second");
        },
      ]),
    ).rejects.toMatchObject({ code: "teardown_failed", details: { causes: ["first failed"] } });
    expect(calls).toEqual(["first", "second"]);
  });

  test("C-ERR-01 stringifies non-Error step failures", async () => {
    await expect(
      runTeardownSteps([() => Promise.reject("primitive teardown failure")]),
    ).rejects.toMatchObject({
      code: "teardown_failed",
      details: { causes: ["primitive teardown failure"] },
    });
  });
});

describe("runCleanupSteps (§9.4)", () => {
  test("runs EVERY step even after an earlier one throws", async () => {
    const ran: string[] = [];
    await expect(
      runCleanupSteps([
        () => {
          ran.push("a");
          throw new Error("bridge stop failed");
        },
        () => {
          ran.push("b"); // must still run despite the earlier throw (no leak)
        },
        () => Promise.reject("watcher finish failed"),
      ]),
    ).rejects.toThrow(/Runtime cleanup failed: bridge stop failed; watcher finish failed/);
    expect(ran).toEqual(["a", "b"]);
  });

  test("resolves when every step succeeds", async () => {
    const ran: string[] = [];
    await expect(
      runCleanupSteps([
        () => {
          ran.push("x");
        },
        () => {
          ran.push("y");
        },
      ]),
    ).resolves.toBeUndefined();
    expect(ran).toEqual(["x", "y"]);
  });
});
