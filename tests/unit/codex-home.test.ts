/**
 * The launch-script step that reports Codex's `CODEX_HOME`, run by a real `/bin/sh` the way the
 * launch shell runs it, and the config path read back from the report by Codex's own rule.
 * Covers PRD §4.2 and §5.3.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { reportCodexHomeCommand, reportedCodexConfigPath } from "../../src/codex/config/home.ts";
import { tempDir } from "../helpers/tmp.ts";

/**
 * Runs `startup`, then the report step and, only if it succeeded, a stand-in for `exec codex`,
 * in `cwd` with `env`. Returns the report path and whether the stand-in ran.
 */
function launch(startup: string, env: NodeJS.ProcessEnv, cwd = realpathSync(tempDir())) {
  const report = join(tempDir("elwood-codex-report-"), "codex-home");
  const script = `${startup}\n${reportCodexHomeCommand(report)} && echo codex-launched`;
  const result = spawnSync("/bin/sh", ["-c", script], { cwd, env, encoding: "utf8" });
  return { report, cwd, launched: result.stdout === "codex-launched\n" };
}

const home = "/Users/elwood-test";

describe("the launch shell's CODEX_HOME report", () => {
  test("an exported CODEX_HOME is the one Codex runs with", () => {
    const { report, cwd, launched } = launch("export CODEX_HOME=/from/zshrc", { HOME: home });
    expect(launched).toBe(true);
    expect(reportedCodexConfigPath({ reportPath: report, cwd })).toBe("/from/zshrc/config.toml");
  });

  test("a relative CODEX_HOME resolves against the session's cwd", () => {
    const { report, cwd } = launch("export CODEX_HOME=relative/codex", { HOME: home });
    expect(reportedCodexConfigPath({ reportPath: report, cwd })).toBe(
      join(cwd, "relative/codex/config.toml"),
    );
  });

  test("an assignment the startup file did not export never reaches Codex", () => {
    const { report, cwd } = launch("CODEX_HOME=/not/exported", { HOME: home });
    expect(reportedCodexConfigPath({ reportPath: report, cwd })).toBe(
      join(home, ".codex", "config.toml"),
    );
  });

  test("a CODEX_HOME with spaces in it arrives whole", () => {
    const { report, cwd } = launch('export CODEX_HOME="/my homes/codex  two"', { HOME: home });
    expect(reportedCodexConfigPath({ reportPath: report, cwd })).toBe(
      "/my homes/codex  two/config.toml",
    );
  });

  test("a HOME with spaces in it arrives whole when CODEX_HOME is unset", () => {
    const { report, cwd } = launch("unset CODEX_HOME", { HOME: "/Users/with  two spaces" });
    expect(reportedCodexConfigPath({ reportPath: report, cwd })).toBe(
      "/Users/with  two spaces/.codex/config.toml",
    );
  });

  test("an empty CODEX_HOME falls back to $HOME/.codex, and an empty HOME to the account's", () => {
    const empty = launch("export CODEX_HOME=", { HOME: "" });
    const fallback = join(userInfo().homedir, ".codex", "config.toml");
    expect(reportedCodexConfigPath({ reportPath: empty.report, cwd: empty.cwd })).toBe(fallback);
  });

  test("Codex does not start when the report cannot be written", () => {
    const cwd = realpathSync(tempDir());
    const report = join(cwd, "missing-dir", "codex-home");
    const script = `${reportCodexHomeCommand(report)} && echo codex-launched`;
    const result = spawnSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8" });
    expect(result.stdout).toBe("");
  });

  test("a report path with a quote in it is written where it says", () => {
    const dir = join(realpathSync(tempDir()), "it's here");
    mkdirSync(dir);
    const report = join(dir, "codex-home");
    const script = `${reportCodexHomeCommand(report)} && echo codex-launched`;
    spawnSync("/bin/sh", ["-c", script], { env: { CODEX_HOME: "/q" }, encoding: "utf8" });
    expect(reportedCodexConfigPath({ reportPath: report, cwd: dir })).toBe("/q/config.toml");
  });
});

describe("reading the report", () => {
  test("a missing report is a model_automation_failed naming it, with its errno", () => {
    const report = join(realpathSync(tempDir()), "never-written");
    expect(() => reportedCodexConfigPath({ reportPath: report, cwd: "/w" })).toThrow(
      expect.objectContaining({
        code: "model_automation_failed",
        details: { path: report, errno: "ENOENT" },
      }),
    );
  });

  test("a report that is not two NUL-terminated values is refused", () => {
    const report = join(realpathSync(tempDir()), "codex-home");
    writeFileSync(report, "/only/one\0");
    expect(() => reportedCodexConfigPath({ reportPath: report, cwd: "/w" })).toThrow(
      expect.objectContaining({
        code: "model_automation_failed",
        details: { path: report, cause: "The report is not two NUL-terminated values." },
      }),
    );
  });
});
