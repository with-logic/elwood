/**
 * Codex's own preflight probes go through the same bounded login-shell wrapper as Claude's, and
 * a login shell that fails before `codex update` runs reports `login_shell_failed` without the
 * profile's output (PRD §9.2, C-PERF-05).
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { probeStartScript } from "../../src/runtime/probe/start.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
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
  setPlatformForTests("darwin");
});
afterEach(() => resetCodexPreflightCacheForTests());

test("C-PERF-05 every Codex probe announces its command after the login shell loads", async () => {
  const scripts: string[] = [];
  setCommandRunnerForTests((_command, args) => {
    scripts.push(args.at(-1) ?? "");
    return { status: 0, stdout: "codex-cli 0.164.0", stderr: "" };
  });
  await preflightCodex(process.cwd(), { autoupdate: true });
  await detectCodexCliCapabilities();
  expect(scripts).toEqual([
    `${probeStartScript}codex --version`,
    `${probeStartScript}codex update`,
    `${probeStartScript}codex --version`,
    `${probeStartScript}codex --help`,
  ]);
});

test("C-PERF-05 a login shell that fails before `codex update` reports login_shell_failed", async () => {
  setCommandRunnerForTests((_command, args) =>
    args.at(-1)?.endsWith("codex update")
      ? {
          status: null,
          stdout: "",
          stderr: "export ELWOOD_SENTINEL_SECRET=hunter2\n",
          error: {
            code: "ETIMEDOUT",
            message: "login shell did not start the probe command within 60000 ms",
            phase: "login_shell",
          },
        }
      : { status: 0, stdout: "codex-cli 0.164.0", stderr: "" },
  );
  const warning = await preflightCodex(process.cwd(), { autoupdate: true });
  expect(warning).toMatchObject({
    code: "agent_update_failed",
    agent: "codex",
    errorCode: "login_shell_failed",
    raw: "",
  });
  expect(JSON.stringify(warning)).not.toContain("hunter2");
});
