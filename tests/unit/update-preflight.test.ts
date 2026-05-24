/**
 * Focused coverage for optional CLI autoupdate.
 * Covers PRD §5.1 and §5.5.
 */

import { describe, expect, test } from "bun:test";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";

describe("CLI autoupdate preflight", () => {
  test("C-CLAUDE-07 runs claude update before version checks", () => {
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
    expect(() => preflightClaude(false, true)).toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
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
});
