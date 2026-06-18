/**
 * Focused unit coverage for serialization, preflight, settings, and state helpers.
 * Covers PRD §4, §6, §8, §9, and §10.
 */

import { describe, expect, test } from "bun:test";
import { buildClaudeShellCommand, shellLaunch } from "../../src/claude/command.ts";
import { claudeHookEventNames } from "../../src/claude/hooks.ts";
import { minimumClaudeVersion, parseVersion, preflightClaude } from "../../src/claude/preflight.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { generateClaudeSettings } from "../../src/claude/settings.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  currentCommandRunner,
  currentPlatform,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { assertStartupUsable } from "../../src/runtime/startup.ts";

describe("serialization", () => {
  test("C-HRESP-06 variants serialize to Claude-compatible output", () => {
    const permission = JSON.parse(
      serializeHookResult("PermissionRequest", { behavior: "allow" }).stdout,
    );
    expect(permission.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(serializeHookResult("PermissionDenied", { retry: true }).stdout).toContain("retry");
    expect(serializeHookResult("Elicitation", { action: "decline" }).stdout).toContain("decline");
    expect(
      serializeHookResult("Stop", { decision: "block", reason: "keep going" }).stdout,
    ).toContain("keep going");
    expect(
      serializeHookResult("Stop", {
        decision: "block",
        reason: "keep going",
        additionalContext: "tests failed",
      }).stdout,
    ).toContain("tests failed");
    expect(
      serializeHookResult("SessionStart", { additionalContext: "branch main" }).stdout,
    ).toContain("branch main");
    expect(serializeHookResult("WorktreeCreate", { worktreePath: "/tmp/w" }).stdout).toBe(
      "/tmp/w\n",
    );
    expect(serializeHookResult("TaskCreated", { continue: false }).stdout).toContain("continue");
  });
});

describe("preflight", () => {
  test("C-CLAUDE-04 version parsing and comparisons cover strict paths", () => {
    expect(parseVersion("claude 2.1.144")).toBe(minimumClaudeVersion);
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => ({ status: 1, stdout: "", stderr: "boom" }));
    expect(() => preflightClaude(false)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({ status: 0, stdout: "unparseable", stderr: "" }));
    expect(() => preflightClaude(false)).not.toThrow();
    expect(() => preflightClaude(true)).toThrow(ElwoodError);
    setCommandRunnerForTests(() => ({ status: 0, stdout: "2.1.1", stderr: "" }));
    expect(() => preflightClaude(false)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("runtime seams expose real defaults", () => {
    expect(typeof currentPlatform()).toBe("string");
    expect(currentCommandRunner()("bun", ["--version"]).stdout.length).toBeGreaterThan(0);
  });

  test("startup readiness detects authentication failures", async () => {
    await expect(
      assertStartupUsable({
        adapter: "codex",
        exit: undefined,
        output: "not logged in",
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: "codex_not_authenticated" });
    await expect(
      assertStartupUsable({
        adapter: "codex",
        exit: undefined,
        output: "The linear MCP server is not logged in.",
        waitMs: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("settings and command construction", () => {
  test("C-CLAUDE-03 C-HOOK-01 launch policy and all hooks are generated", () => {
    const command = buildClaudeShellCommand("/tmp/settings.json", {
      cwd: "/tmp/project",
      permissionMode: "plan",
      allowedTools: ["Bash", "Read"],
      name: "demo",
    });
    expect(command).toContain("--permission-mode");
    expect(command).toContain("--allowedTools");
    expect(command).toContain("--name");
    expect(shellLaunch("/bin/zsh", command).args).toContain("-c");
    const settings = generateClaudeSettings({
      bridgeScriptPath: "/tmp/bridge.mjs",
      timeoutSeconds: 3,
      options: {
        disallowedTools: ["AskUserQuestion"],
        settingsOverrides: { permissions: { allow: ["Read"] } },
      },
    });
    expect(JSON.stringify(settings)).toContain("bridge.mjs");
    expect(JSON.stringify(settings)).toContain("Read");
    expect(Object.keys(settings["hooks"] as Record<string, unknown>).sort()).toEqual(
      [...claudeHookEventNames].sort(),
    );
    const minimalSettings = generateClaudeSettings({
      bridgeScriptPath: "/tmp/bridge.mjs",
      timeoutSeconds: 3,
      options: {},
    });
    expect("permissions" in minimalSettings).toBe(false);
  });
});
