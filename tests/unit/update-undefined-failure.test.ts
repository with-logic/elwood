/** Failed updates warn even when rejection has no value (PRD §9.2, C-LIFE-11). */
import { expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { setUpdateCoordinatorForTests } from "../../src/runtime/update/once.ts";

test.each([
  { agent: "claude", preflight: preflightClaude, version: "2.1.305", stdout: "2.1.305" },
  { agent: "codex", preflight: preflightCodex, version: "0.150.0", stdout: "codex-cli 0.150.0" },
] as const)("C-LIFE-11 $agent shares an undefined updater rejection and warns each caller", async ({
  agent,
  preflight,
  version,
  stdout,
}) => {
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((_adapter, update) => update());
  let updates = 0;
  setCommandRunnerForTests((_shell, args) => {
    if (args.join(" ").includes(`${agent} update`)) {
      updates++;
      return Promise.reject(undefined);
    }
    return { status: 0, stdout, stderr: "" };
  });
  const warning = {
    agent,
    source: "lifecycle",
    code: "agent_update_failed",
    severity: "warning",
    installedVersion: version,
    errorCode: "update_failed",
    raw: "",
    message: `\`${agent} update\` failed; continuing with the installed CLI ${version}.`,
  };
  await expect(preflight(false, true)).resolves.toEqual(warning);
  await expect(preflight(false, true)).resolves.toEqual(warning);
  expect(updates).toBe(1);
});
