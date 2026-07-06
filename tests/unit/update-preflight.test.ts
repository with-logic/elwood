/**
 * Focused coverage for optional CLI autoupdate and version comparison.
 * Covers PRD §5.1, §5.5, and §9.2.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { compareVersions, preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import { resetAutoupdateForTests } from "../../src/runtime/update-once.ts";

describe("CLI autoupdate preflight", () => {
  beforeEach(resetAutoupdateForTests);

  test("C-CLAUDE-07 runs claude update before spawning", () => {
    const commands: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    preflightClaude(false, true);
    expect(commands.some((command) => command.includes("claude update"))).toBe(true);
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? { status: 1, stdout: "", stderr: "failed" }
        : { status: 0, stdout: "2.1.144", stderr: "" },
    );
    resetAutoupdateForTests();
    expect(() => preflightClaude(false, true)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CLAUDE-09 validates the post-update version", () => {
    const outputs = ["2.1.1", "2.1.144"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "2.1.144", stderr: "" };
    });
    expect(() => preflightClaude(false, true)).not.toThrow();
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    });
    expect(() => preflightClaude(false, true)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CLAUDE-04 treats missing or malformed version parts as zero", () => {
    expect(compareVersions("2.1", "2.1")).toBe(0);
    expect(compareVersions("2..3", "2.0.3")).toBe(0);
    expect(compareVersions("2.1.x", "2.1.0")).toBe(0);
  });

  test("C-CODEX-08 runs codex update and reports failures", () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("codex update")
        ? { status: 1, stdout: "", stderr: "failed" }
        : { status: 0, stdout: "codex-cli 0.132.0", stderr: "" },
    );
    expect(() => preflightCodex(false, true)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CODEX-10 validates the post-update version", () => {
    const outputs = ["codex-cli 0.1.0", "codex-cli 0.132.0"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "codex-cli 0.132.0", stderr: "" };
    });
    expect(() => preflightCodex(false, true)).not.toThrow();
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    });
    expect(() => preflightCodex(false, true)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });
});

describe("autoupdate dedupe", () => {
  beforeEach(resetAutoupdateForTests);

  test("C-LIFE-09 autoupdate runs at most once per adapter per process", () => {
    const commands: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      commands.push(args.join(" "));
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    preflightClaude(false, true);
    preflightClaude(false, true);
    preflightCodex(false, true);
    preflightCodex(false, true);
    const updates = commands.filter((command) => command.includes(" update"));
    expect(updates.filter((command) => command.includes("claude update"))).toHaveLength(1);
    expect(updates.filter((command) => command.includes("codex update"))).toHaveLength(1);
    resetRuntimeSeamsForTests();
  });
});
