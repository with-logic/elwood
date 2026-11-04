/** Setup ENOENT differs from a missing CLI across adapters (PRD §9.2, C-ERR-08). */
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { isProbeSetupError } from "../../src/runtime/probe/setup-error.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";

beforeEach(() => {
  setPlatformForTests("darwin");
  resetPreflightCacheForTests();
});

for (const [agent, preflight] of [
  ["claude", preflightClaude],
  ["codex", preflightCodex],
] as const) {
  test.each([true, false])(`C-ERR-08 ${agent} distinguishes setup ENOENT (%s)`, async (setup) => {
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: {
        code: "ENOENT",
        message: "native failure",
        ...(setup ? { origin: "probe_setup" as const } : {}),
      },
    }));
    await expect(preflight(false)).rejects.toMatchObject({
      code: `${agent}_${setup ? "start_failed" : "not_found"}`,
      details: { errno: "ENOENT", cause: "native failure" },
    });
  });
}

test.each([
  null,
  "failure",
  {},
  { origin: "other" },
])("C-ERR-08 unknown failures do not establish probe-setup provenance (%s)", (failure) =>
  expect(isProbeSetupError(failure)).toBe(false));
