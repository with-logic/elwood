/**
 * Unit coverage for the best-effort `agent_update_failed` warning builder (PRD §9.2, C-LIFE-11):
 * it extracts SAFE diagnostics from a contained update error and never leaks content.
 */

import { describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { buildUpdateWarning } from "../../src/core/warnings/update.ts";

describe("buildUpdateWarning", () => {
  test("carries the installed version, errno, and bounded stderr from an ElwoodError", () => {
    const error = elwoodError("claude_update_failed", "`claude update` failed.", {
      stderr: "boom",
      errno: "ETIMEDOUT",
    });
    expect(buildUpdateWarning("claude", "2.1.223", error)).toEqual({
      agent: "claude",
      source: "lifecycle",
      code: "agent_update_failed",
      severity: "warning",
      message: "`claude update` failed; continuing with the installed CLI 2.1.223.",
      installedVersion: "2.1.223",
      errorCode: "ETIMEDOUT",
      raw: "boom",
    });
  });

  test("C-PERF-05 a login shell that never ran the update reports login_shell_failed", () => {
    const error = elwoodError("claude_update_failed", "`claude update` failed.", {
      stderr: "",
      cause: "login shell did not start the probe command within 60000 ms",
      errno: "ETIMEDOUT",
      phase: "login_shell",
    });
    expect(buildUpdateWarning("claude", "2.1.310", error).errorCode).toBe("login_shell_failed");
  });

  test("falls back to a generic error code and empty stderr for a non-ElwoodError / no details", () => {
    const warning = buildUpdateWarning("codex", "0.132.0", new Error("plain failure"));
    expect(warning.errorCode).toBe("update_failed"); // no allowlisted errno available
    expect(warning.raw).toBe(""); // no stderr to surface
    expect(warning.installedVersion).toBe("0.132.0");
  });

  test("truncates an oversized stderr to keep the warning payload bounded", () => {
    const error = elwoodError("claude_update_failed", "failed", { stderr: "x".repeat(5000) });
    const warning = buildUpdateWarning("claude", "2.1.223", error);
    expect(warning.raw.length).toBeLessThanOrEqual(2000); // the 2 KB `maxStderr` cap
  });
});

test("C-PERF-04 contention reports a skipped active updater rather than a failed local command", () => {
  const warning = buildUpdateWarning(
    "codex",
    "0.154.0",
    elwoodError("codex_update_failed", "internal", { updateReason: "active_owner" }),
  );
  expect(warning.errorCode).toBe("update_active");
  expect(warning.message).toBe(
    "`codex update` skipped: another updater is still active; continuing with the installed CLI 0.154.0.",
  );
  expect(warning.raw).toBe("");
});

// The second contention reason shares `update_active` but names a different cause, and it
// must stay distinguishable in the message: a lease held by a surviving process group is
// not a peer that is merely slow, and it is reported without waiting out the contention bound.
test.each([
  ["claude", "2.1.200"],
  ["codex", "0.154.0"],
] as const)("C-PERF-04 a %s lease held by a surviving updater group reports update_active", (adapter, installedVersion) => {
  const warning = buildUpdateWarning(
    adapter,
    installedVersion,
    elwoodError(`${adapter}_update_failed`, "internal", {
      updateReason: "cleanup_pending",
      cleanupErrorCode: "ETIMEDOUT",
    }),
  );
  expect(warning.errorCode).toBe("update_active");
  expect(warning.message).toBe(
    `\`${adapter} update\` skipped: another updater's process group has not exited; continuing with the installed CLI ${installedVersion}.`,
  );
  // No local updater ran, so there is no errno to surface and no updater stderr to bound.
  expect(warning.raw).toBe("");
});
