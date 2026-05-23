/**
 * Focused unit coverage for serialization, preflight, settings, and state helpers.
 * Covers PRD §4, §6, §8, §9, and §10.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeShellCommand, shellLaunch } from "../../src/claude/command.ts";
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
import { defaultStateDir, readSessionRecord, sessionDir } from "../../src/state/store.ts";

describe("serialization", () => {
  test("C-HRESP variants serialize to Claude-compatible output", () => {
    expect(serializeHookResult("PermissionRequest", { behavior: "allow" }).stdout).toContain(
      "decision",
    );
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
    expect(serializeHookResult("WorktreeRemove", { worktreePath: "/tmp/w" }).stdout).toContain(
      "worktreePath",
    );
  });
});

describe("preflight", () => {
  test("C-CLAUDE version parsing and comparisons cover strict paths", () => {
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
});

describe("settings and command construction", () => {
  test("C-CLAUDE launch policy is reflected in generated command/settings", () => {
    const command = buildClaudeShellCommand("/tmp/settings.json", {
      cwd: "/tmp/project",
      permissionMode: "plan",
      allowedTools: ["Bash", "Read"],
      name: "demo",
    });
    expect(command).toContain("--permission-mode");
    expect(command).toContain("--tools");
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
    expect(JSON.stringify(settings)).toContain("AskUserQuestion");
  });
});

describe("state store", () => {
  test("C-STATE error paths are typed", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    expect(defaultStateDir(root)).toBe(join(root, ".elwood"));
    expect(sessionDir(root, "missing")).toBe(join(root, "sessions", "missing"));
    expect(() => readSessionRecord(root, "missing")).toThrow(ElwoodError);
    const dir = sessionDir(root, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), '{"schemaVersion":2,"elwoodSessionId":"bad"}');
    expect(() => readSessionRecord(root, "bad")).toThrow(ElwoodError);
  });
});
