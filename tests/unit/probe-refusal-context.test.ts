/** Definite probe refusals keep bounded recovery context through consumers (PRD §9.2, C-API-61). */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { ElwoodError, elwoodError } from "../../src/core/errors.ts";
import { probeCommandRefusedReason, probeRefusalContext } from "../../src/core/probe-refusal.ts";
import { buildUpdateWarning } from "../../src/core/warnings/update.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  checkLaunchDirectory,
  recheckLaunchDirectoryOnFailure,
} from "../../src/runtime/session/launch-directory.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

test.each([
  "Claude version probe",
  "Codex version probe",
  "Codex help probe",
] as const)("C-API-61 a replaced workspace preserves %s context through launch rechecking", async (label) => {
  const agent = label.startsWith("Claude") ? "claude" : "codex";
  const root = tempDir("elwood-refusal-context-");
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  setPlatformForTests("darwin");
  setCommandRunnerForTests(runProbe);
  const directory = await checkLaunchDirectory(agent, cwd);
  const failure = await recheckLaunchDirectoryOnFailure(directory, async () => {
    renameSync(cwd, join(root, "original"));
    mkdirSync(cwd);
    if (label === "Codex help probe") return await detectCodexCliCapabilities(directory);
    return await (agent === "claude" ? preflightClaude : preflightCodex)(false, false, directory);
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ElwoodError);
  if (!(failure instanceof ElwoodError)) throw new Error("Missing typed startup failure.");
  expect(failure).toMatchObject({
    code: `${agent}_start_failed`,
    details: { cwd, cause: probeCommandRefusedReason, stderr: "" },
  });
  expect(failure.message).toContain(`${label}: ${probeCommandRefusedReason}`);
  expect(failure.message).not.toContain(root);
});

test.each([
  ["claude", "claude_start_failed", "`claude --version` failed.", "Claude version probe"],
  ["codex", "codex_start_failed", "`codex --version` failed.", "Codex version probe"],
  ["codex", "codex_start_failed", "`codex --help` failed.", "Codex help probe"],
  ["claude", "claude_update_failed", "`claude update` failed.", "Claude update probe"],
  ["codex", "codex_update_failed", "`codex update` failed.", "Codex update probe"],
] as const)("C-API-61 %s update warnings retain the actual %s refusal context", (agent, code, message, label) => {
  const warning = buildUpdateWarning(
    agent,
    "9.9.9",
    elwoodError(code, message, { cause: probeCommandRefusedReason, stderr: "" }),
  );
  expect(warning).toMatchObject({
    message: `${label}: ${probeCommandRefusedReason} Continuing with the installed CLI 9.9.9.`,
    installedVersion: "9.9.9",
    errorCode: "update_failed",
    raw: "",
  });
});

test.each([
  new Error("FAKE-SECRET profile output"),
  elwoodError("claude_start_failed", "`claude --version` failed.", { cause: "FAKE-SECRET" }),
  elwoodError("claude_start_failed", "FAKE-SECRET /private/user/work", {
    cause: probeCommandRefusedReason,
  }),
  elwoodError("state_corrupt", "`claude --version` failed.", { cause: probeCommandRefusedReason }),
  elwoodError("claude_start_failed", "`claude --version` failed.", {
    cause: probeCommandRefusedReason,
    phase: "command_start_unobserved",
  }),
])("C-API-61 unrecognized or ambiguous errors supply no refusal display text (%#)", (error) => {
  expect(probeRefusalContext(error)).toBeUndefined();
  const warning = buildUpdateWarning("claude", "2.1.310", error);
  expect(warning.message).toBe(
    "`claude update` failed; continuing with the installed CLI 2.1.310.",
  );
  expect(warning.message).not.toContain("FAKE-SECRET");
  expect(warning.message).not.toContain("/private/user/work");
});
