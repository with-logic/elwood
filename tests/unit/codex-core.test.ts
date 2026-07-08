/**
 * Focused unit coverage for Codex command, preflight, serialization, and validation.
 * Covers PRD §4.4, §7A, §9, and §10.
 */

import { describe, expect, test } from "vitest";
import { buildCodexShellCommand } from "../../src/codex/command.ts";
import {
  minimumCodexVersion,
  parseCodexVersion,
  preflightCodex,
} from "../../src/codex/preflight.ts";
import { serializeCodexHookResult } from "../../src/codex/serialize.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  type CommandResult,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update-once.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex core helpers", () => {
  test("C-CODEX-03 command construction reflects launch policy", () => {
    const cwd = tempDirForUnit();
    const record = createSessionRecord({
      stateDir: `${cwd}/.elwood`,
      cwd,
      id: "s1",
      adapter: "codex",
      name: "demo",
    });
    const command = buildCodexShellCommand(
      { ...record, codex: { resumeId: "codex-1" } },
      {
        cwd,
        model: "gpt-5.3-codex",
        profile: "work",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        configOverrides: ['model="gpt-5.3-codex"'],
      },
    );
    expect(command).toContain("--model 'gpt-5.3-codex'");
    expect(command).toContain("--profile 'work'");
    expect(command).toContain("--sandbox 'workspace-write'");
    expect(command).toContain("--ask-for-approval 'never'");
    expect(command).toContain(`--cd '${record.cwd}'`);
    expect(command).toContain("-c 'model=\"gpt-5.3-codex\"'");
    expect(command.lastIndexOf("features.hooks=true")).toBeGreaterThan(command.indexOf("model="));
    expect(command.lastIndexOf("hookTrust")).toBeGreaterThan(command.indexOf("model="));
    expect(command.lastIndexOf("hookTrust")).toBeGreaterThan(
      command.indexOf("features.hooks=true"),
    );
    expect(command).toContain("resume");
    expect(command).toContain("command=\"'");
    expect(
      buildCodexShellCommand(record, { cwd }, { supportsHookTrustBypass: false }),
    ).not.toContain("--dangerously-bypass-hook-trust");
  });

  test("C-CODEX-04 version parsing and strict failure paths are typed", async () => {
    // Each fresh `--version` output must be re-read, so clear the per-process
    // version cache whenever the fake runner changes output.
    const setVersion = (result: CommandResult) => {
      resetPreflightCacheForTests();
      setCommandRunnerForTests(() => result);
    };
    expect(parseCodexVersion("codex-cli 0.132.0")).toBe("0.132.0");
    expect(minimumCodexVersion).toBe("0.124.0");
    setPlatformForTests("linux");
    await expect(preflightCodex(false)).rejects.toThrow(ElwoodError);
    setPlatformForTests("darwin");
    setVersion({ status: 1, stdout: "", stderr: "boom" });
    await expect(preflightCodex(false)).rejects.toThrow(ElwoodError);
    setVersion({
      status: null,
      stdout: "",
      stderr: "terminated",
      error: { code: "SIGTERM", message: "terminated" },
    });
    // C-PERF-03: the underlying cause/errno is preserved in details.
    await expect(preflightCodex(false)).rejects.toMatchObject({
      code: "codex_start_failed",
      details: { stderr: "terminated", cause: "terminated", errno: "SIGTERM" },
    });
    // An error without a code carries the cause but no synthetic errno.
    setVersion({ status: null, stdout: "", stderr: "gone", error: { message: "spawn died" } });
    await expect(preflightCodex(false)).rejects.toMatchObject({
      code: "codex_start_failed",
      details: { stderr: "gone", cause: "spawn died" },
    });
    setVersion({ status: 0, stdout: "unparseable", stderr: "" });
    // Non-strict unparseable version resolves with a warning (does not throw).
    await expect(preflightCodex(false)).resolves.toMatchObject({ code: "version_unparseable" });
    await expect(preflightCodex(true)).rejects.toThrow(ElwoodError);
    setVersion({ status: 0, stdout: `codex-cli ${minimumCodexVersion}\n`, stderr: "" });
    await expect(preflightCodex(true)).resolves.toBeUndefined();
    setVersion({ status: 0, stdout: "0.1.0", stderr: "" });
    await expect(preflightCodex(false)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-HRESP-10 serializes Codex hook response variants", () => {
    expect(
      serializeCodexHookResult("Stop", { continue: false, stopReason: "run tests" }).stdout,
    ).toContain("continue");
    expect(
      serializeCodexHookResult("PreToolUse", {
        permissionDecision: "allow",
        updatedInput: { command: "echo ok" },
      }).stdout,
    ).toContain("updatedInput");
    expect(
      serializeCodexHookResult("Stop", {
        decision: "block",
        reason: "again",
        additionalContext: "ctx",
      }).stdout,
    ).toContain("again");
    expect(
      JSON.parse(serializeCodexHookResult("PermissionRequest", { behavior: "allow" }).stdout)
        .hookSpecificOutput.decision.behavior,
    ).toBe("allow");
  });
});
