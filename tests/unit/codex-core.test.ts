/**
 * Focused unit coverage for Codex command, preflight, serialization, and validation.
 * Covers PRD §4.4, §7A, §9, and §10.
 */

import { describe, expect, test } from "bun:test";
import { buildCodexShellCommand } from "../../src/codex/command.ts";
import {
  detectCodexCliCapabilities,
  minimumCodexVersion,
  parseCodexVersion,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { serializeCodexHookResult } from "../../src/codex/serialize.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex core helpers", () => {
  test("C-CODEX command construction reflects launch policy", () => {
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
        profile: "work",
        approvalPolicy: "never",
        configOverrides: ['model="gpt-5.3-codex"'],
      },
    );
    expect(command).toContain("--profile");
    expect(command).toContain("--ask-for-approval");
    expect(command).toContain("model=");
    expect(command.lastIndexOf("hookTrust")).toBeGreaterThan(command.indexOf("model="));
    expect(command).toContain("resume");
    expect(
      buildCodexShellCommand(record, { cwd }, { supportsHookTrustBypass: false }),
    ).not.toContain("--dangerously-bypass-hook-trust");
  });

  test("C-CODEX version parsing and strict failure paths are typed", () => {
    expect(parseCodexVersion("codex-cli 0.132.0")).toBe("0.132.0");
    expect(minimumCodexVersion).toBe("0.124.0");
    setPlatformForTests("linux");
    expect(() => preflightCodex(false)).toThrow(ElwoodError);
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => ({ status: 1, stdout: "", stderr: "boom" }));
    expect(() => preflightCodex(false)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unparseable", stderr: "" }));
    expect(() => preflightCodex(false)).not.toThrow();
    expect(() => preflightCodex(true)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({
      status: 0,
      stdout: `codex-cli ${minimumCodexVersion}\n`,
      stderr: "",
    }));
    expect(() => preflightCodex(true)).not.toThrow();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "0.1.0", stderr: "" }));
    expect(() => preflightCodex(false)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CODEX-06 detects hook trust bypass support from login shell help", () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("--help")
        ? { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }
        : { status: 0, stdout: "codex-cli 0.133.0", stderr: "" },
    );
    expect(detectCodexCliCapabilities().supportsHookTrustBypass).toBe(true);
    resetCodexPreflightCacheForTests();
    setCommandRunnerForTests(() => ({ status: 0, stdout: "codex help", stderr: "" }));
    expect(detectCodexCliCapabilities().supportsHookTrustBypass).toBe(false);
    resetCodexPreflightCacheForTests();
    resetRuntimeSeamsForTests();
  });

  test("C-HRESP-10 serializes Codex hook response variants", () => {
    expect(serializeCodexHookResult("PostCompact", { continue: false }).stdout).toContain(
      "continue",
    );
    expect(
      serializeCodexHookResult("PostCompact", { additionalContext: "compacted" }).stdout,
    ).toContain("additionalContext");
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
        .hookSpecificOutput.behavior,
    ).toBe("allow");
  });
});
