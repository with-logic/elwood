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
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
} from "../../src/runtime/update-once.ts";

function resetPreflight(): void {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
}

describe("CLI autoupdate preflight", () => {
  beforeEach(resetPreflight);

  test("C-CLAUDE-07 runs claude update before spawning", async () => {
    const commands: string[] = [];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      return { status: 0, stdout: "2.1.144", stderr: "" };
    });
    await preflightClaude(false, true);
    expect(commands.some((command) => command.includes("claude update"))).toBe(true);
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? { status: 1, stdout: "", stderr: "failed" }
        : { status: 0, stdout: "2.1.144", stderr: "" },
    );
    resetPreflight();
    await expect(preflightClaude(false, true)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-PERF-03 a bounded claude update probe fails with cause/errno", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? {
            status: null,
            stdout: "",
            stderr: "",
            error: { code: "E2BIG", message: "probe output exceeded 1000000 bytes" },
          }
        : { status: 0, stdout: "2.1.144", stderr: "" },
    );
    await expect(preflightClaude(false, true)).rejects.toMatchObject({
      code: "claude_update_failed",
      details: { cause: "probe output exceeded 1000000 bytes", errno: "E2BIG" },
    });
    resetRuntimeSeamsForTests();
  });

  test("C-CLAUDE-09 validates the post-update version", async () => {
    const outputs = ["2.1.1", "2.1.144"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "2.1.144", stderr: "" };
    });
    await expect(preflightClaude(false, true)).resolves.toBeUndefined();
    // Re-arm autoupdate and clear the cached version so the new runner's
    // missing-binary output is actually read.
    resetPreflight();
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    });
    await expect(preflightClaude(false, true)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CLAUDE-04 treats missing or malformed version parts as zero", () => {
    expect(compareVersions("2.1", "2.1")).toBe(0);
    expect(compareVersions("2..3", "2.0.3")).toBe(0);
    expect(compareVersions("2.1.x", "2.1.0")).toBe(0);
  });

  test("C-CODEX-08 runs codex update and reports failures", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("codex update")
        ? { status: 1, stdout: "", stderr: "failed" }
        : { status: 0, stdout: "codex-cli 0.132.0", stderr: "" },
    );
    await expect(preflightCodex(false, true)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });

  test("C-CODEX-10 validates the post-update version", async () => {
    const outputs = ["codex-cli 0.1.0", "codex-cli 0.132.0"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "codex-cli 0.132.0", stderr: "" };
    });
    await expect(preflightCodex(false, true)).resolves.toBeUndefined();
    // Re-arm autoupdate and clear the cached version so the new runner's
    // missing-binary output is actually read.
    resetPreflight();
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    });
    await expect(preflightCodex(false, true)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });
});
