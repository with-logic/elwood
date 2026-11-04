/** Confirmed no-attempt updates remain observable without verification data (PRD §9.2, C-LIFE-11). */
import { expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { probeCommandRefusedReason } from "../../src/core/probe-refusal.ts";
import { buildUpdateWarning } from "../../src/core/warnings/update.ts";

const secret = "FAKE-SECRET /private/verification/path";
const failures = [
  ["undefined rejection", undefined],
  ["null rejection", null],
  ["primitive rejection", secret],
  ["native failure", Object.assign(new Error(secret), { code: "ENOENT", path: secret })],
  [
    "typed verification failure",
    elwoodError("claude_start_failed", secret, {
      cause: secret,
      stdout: secret,
      stderr: secret,
      errno: "EACCES",
      exitStatus: 23,
      path: secret,
      phase: "command_start_unobserved",
    }),
  ],
] as const;

for (const agent of ["claude", "codex"] as const) {
  test.each(
    failures,
  )(`C-LIFE-11 ${agent} reports a confirmed no-attempt with %s`, (_name, error) => {
    const warning = buildUpdateWarning(agent, "9.9.9", error, true);
    expect(warning).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_not_started",
      message: `\`${agent} update\` was not started; continuing with the installed CLI 9.9.9.`,
      installedVersion: "9.9.9",
      raw: "",
    });
    expect(warning).not.toHaveProperty("exitStatus");
    expect(JSON.stringify(warning)).not.toContain("FAKE-SECRET");
    expect(JSON.stringify(warning)).not.toContain("/private/verification/path");
    expect(JSON.stringify(warning)).not.toContain("EACCES");
  });
}

test.each([
  ["claude", "claude_start_failed", "`claude --version` failed.", "Claude version probe"],
  ["codex", "codex_update_failed", "`codex update` failed.", "Codex update probe"],
] as const)("C-LIFE-11 %s no-attempt warnings keep only recognized %s refusal context", (agent, code, message, label) => {
  const warning = buildUpdateWarning(
    agent,
    "9.9.9",
    elwoodError(code, message, {
      cause: probeCommandRefusedReason,
      stderr: secret,
      exitStatus: 23,
    }),
    true,
  );
  expect(warning.message).toBe(
    `\`${agent} update\` was not started. ${label}: ${probeCommandRefusedReason} Continuing with the installed CLI 9.9.9.`,
  );
  expect(warning.errorCode).toBe("update_not_started");
  expect(warning.raw).toBe("");
  expect(warning).not.toHaveProperty("exitStatus");
});

test.each([
  "active_owner",
  "cleanup_pending",
])("C-LIFE-11 known %s no-attempt contention retains update_active", (updateReason) => {
  const warning = buildUpdateWarning(
    "claude",
    "2.1.310",
    elwoodError("claude_update_failed", secret, {
      updateReason,
      stderr: secret,
      errno: "EACCES",
      exitStatus: 23,
    }),
    true,
  );
  expect(warning.errorCode).toBe("update_active");
  expect(warning.message).toContain("`claude update` skipped:");
  expect(warning.raw).toBe("");
  expect(warning).not.toHaveProperty("exitStatus");
  expect(JSON.stringify(warning)).not.toContain("FAKE-SECRET");
});
