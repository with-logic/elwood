/**
 * Focused coverage for optional CLI autoupdate and version comparison.
 * Covers PRD §5.1, §5.5, §9.2 — including the BEST-EFFORT update contract (C-LIFE-09/11): a
 * failed update is non-fatal when the installed CLI is compatible, is shared once, and never
 * poisons another start.
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
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update-once.ts";

function resetPreflight(): void {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
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
    resetRuntimeSeamsForTests();
  });

  test("C-LIFE-11 a failed update with a COMPATIBLE installed CLI warns and continues (Claude)", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests(
      (_command, args) =>
        args.join(" ").includes("claude update")
          ? { status: 1, stdout: "", stderr: "network error" }
          : { status: 0, stdout: "2.1.223", stderr: "" }, // installed >= min 2.1.144
    );
    // Best-effort: does NOT reject — returns the warning naming the installed version in use.
    const warning = await preflightClaude(false, true);
    expect(warning).toMatchObject({
      code: "agent_update_failed",
      agent: "claude",
      installedVersion: "2.1.223",
      raw: "network error",
    });
    resetRuntimeSeamsForTests();
  });

  test("C-LIFE-11 a bounded/timed-out update carries its errno into the warning, not a fatal error", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? {
            status: null,
            stdout: "",
            stderr: "",
            error: { code: "ETIMEDOUT", message: "probe timed out" },
          }
        : { status: 0, stdout: "2.1.223", stderr: "" },
    );
    const warning = await preflightClaude(false, true);
    expect(warning).toMatchObject({ code: "agent_update_failed", errorCode: "ETIMEDOUT" });
    resetRuntimeSeamsForTests();
  });

  test("C-LIFE-11 a failed update with an INCOMPATIBLE installed CLI is fatal (Claude)", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests(
      (_command, args) =>
        args.join(" ").includes("claude update")
          ? { status: 1, stdout: "", stderr: "failed" }
          : { status: 0, stdout: "2.1.1", stderr: "" }, // below min 2.1.144
    );
    await expect(preflightClaude(false, true)).rejects.toMatchObject({
      code: "claude_version_unsupported",
    });
    resetRuntimeSeamsForTests();
  });

  test("C-LIFE-11 a failed update validates a freshly changed installed version", async () => {
    const versions = ["2.1.223", "2.1.1"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) =>
      args.join(" ").includes("claude update")
        ? { status: 1, stdout: "", stderr: "partially replaced" }
        : { status: 0, stdout: versions.shift() ?? "2.1.1", stderr: "" },
    );
    await expect(preflightClaude(false, true)).rejects.toMatchObject({
      code: "claude_version_unsupported",
      details: { found: "2.1.1" },
    });
    expect(versions).toHaveLength(0);
  });

  test("C-CLAUDE-09 validates the post-update version; a missing binary after update is fatal", async () => {
    const outputs = ["2.1.1", "2.1.144"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("claude update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "2.1.144", stderr: "" };
    });
    await expect(preflightClaude(false, true)).resolves.toBeUndefined();
    // A missing binary on the post-update read is a real fatal (`claude_not_found`), unrelated
    // to the best-effort update path.
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

  test("C-LIFE-11 a failed update with a COMPATIBLE installed CLI warns and continues (Codex)", async () => {
    setPlatformForTests("darwin");
    setCommandRunnerForTests(
      (_command, args) =>
        args.join(" ").includes("codex update")
          ? { status: 1, stdout: "", stderr: "failed" }
          : { status: 0, stdout: "codex-cli 0.132.0", stderr: "" }, // >= min 0.124.0
    );
    const warning = await preflightCodex(false, true);
    expect(warning).toMatchObject({
      code: "agent_update_failed",
      agent: "codex",
      installedVersion: "0.132.0",
    });
    resetRuntimeSeamsForTests();
  });

  test("C-CODEX-10 validates the post-update version; a missing binary after update is fatal", async () => {
    const outputs = ["codex-cli 0.1.0", "codex-cli 0.132.0"];
    setPlatformForTests("darwin");
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: outputs.shift() ?? "codex-cli 0.132.0", stderr: "" };
    });
    await expect(preflightCodex(false, true)).resolves.toBeUndefined();
    resetPreflight();
    setCommandRunnerForTests((_command, args) => {
      if (args.join(" ").includes("codex update")) return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    });
    await expect(preflightCodex(false, true)).rejects.toThrow(ElwoodError);
    resetRuntimeSeamsForTests();
  });
});
