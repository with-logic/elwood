/**
 * Focused unit coverage for serialization, preflight, settings, and state helpers.
 * Covers PRD §4, §6, §8, §9, and §10.
 */

import { describe, expect, test } from "vitest";
import { buildClaudeShellCommand, shellLaunch } from "../../src/claude/command.ts";
import { claudeHookEventNames } from "../../src/claude/hooks.ts";
import { minimumClaudeVersion, parseVersion, preflightClaude } from "../../src/claude/preflight.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { generateClaudeSettings } from "../../src/claude/settings.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  type CommandResult,
  currentCommandRunner,
  currentPlatform,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { assertStartupUsable } from "../../src/runtime/startup.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update-once.ts";

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
  test("C-CLAUDE-04 version parsing and comparisons cover strict paths", async () => {
    // Clear the per-process version cache whenever the fake changes output.
    const setVersion = (result: CommandResult) => {
      resetPreflightCacheForTests();
      setCommandRunnerForTests(() => result);
    };
    expect(parseVersion("claude 2.1.144")).toBe(minimumClaudeVersion);
    setPlatformForTests("darwin");
    setVersion({ status: 1, stdout: "", stderr: "boom" });
    // A plain non-zero probe carries stderr and no synthetic cause/errno.
    await expect(preflightClaude(false)).rejects.toMatchObject({
      code: "claude_start_failed",
      details: { stderr: "boom" },
    });
    // C-PERF-03: a bounded-probe failure (timeout/overflow) surfaces the
    // runner's cause/errno through the same start-failure name.
    setVersion({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ETIMEDOUT", message: "probe timed out after 15000 ms" },
    });
    await expect(preflightClaude(false)).rejects.toMatchObject({
      code: "claude_start_failed",
      details: { cause: "probe timed out after 15000 ms", errno: "ETIMEDOUT" },
    });
    setVersion({ status: 0, stdout: "unparseable", stderr: "" });
    // Non-strict unparseable version resolves with a warning (does not throw).
    await expect(preflightClaude(false)).resolves.toMatchObject({ code: "version_unparseable" });
    await expect(preflightClaude(true)).rejects.toThrow(ElwoodError);
    setVersion({ status: 0, stdout: "2.1.1", stderr: "" });
    await expect(preflightClaude(false)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("runtime seams expose real defaults", async () => {
    expect(typeof currentPlatform()).toBe("string");
    expect((await currentCommandRunner()("node", ["--version"])).stdout.length).toBeGreaterThan(0);
  });

  test("startup readiness detects authentication failures", async () => {
    for (const adapter of ["claude", "codex"] as const) {
      for (const output of ["not authenticated", "login required", "authentication failed"]) {
        await expect(
          assertStartupUsable({ adapter, exit: undefined, output, waitMs: 0 }),
        ).rejects.toMatchObject({
          code: `${adapter}_not_authenticated`,
        });
      }
    }
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

  test("C-CLAUDE-17 startup rejects lapsed-login banners that only direct the user to /login", async () => {
    for (const output of [
      "Login expired\n Please run /login",
      "Session expired. Please run /login to sign in again.",
      "OAuth token revoked\n Please run /login",
      "Run /login to sign in with your claude.ai account",
      // The signed-out banner, both inline and spanning lines (C-CLAUDE-17).
      "Not logged in · Run /login",
      "⚠ Not logged in\n  Please run /login",
    ]) {
      await expect(
        assertStartupUsable({ adapter: "claude", exit: undefined, output, waitMs: 0 }),
      ).rejects.toMatchObject({ code: "claude_not_authenticated" });
    }
    // An unrelated mention of "login" without a /login recovery directive must NOT
    // be mistaken for an auth failure — the session is usable.
    await expect(
      assertStartupUsable({
        adapter: "claude",
        exit: undefined,
        output: "Loading login history for your dashboard",
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
      tools: ["Bash", "Read", "Edit"],
      name: "demo",
    });
    expect(command).toContain("--permission-mode 'plan'");
    expect(command).toContain("--allowedTools 'Bash,Read'");
    // C-CLAUDE-13: --tools is a true allowlist; empty means all disabled.
    expect(command).toContain("--tools 'Bash,Read,Edit'");
    expect(buildClaudeShellCommand("/tmp/settings.json", { cwd: "/tmp/p", tools: [] })).toContain(
      "--tools ''",
    );
    expect(command).toContain("--name 'demo'");
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
