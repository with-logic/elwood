/**
 * The launch-script step that reports Codex's `CODEX_HOME`, run by a real `/bin/sh` the way the
 * launch shell runs it, and the config path read back from the report by Codex's own rule.
 * Covers PRD §4.2 and §5.3.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  reportCodexHomeCommand,
  reportedCodexConfigPath,
  reportFailedStatus,
} from "../../src/codex/config/home.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { tempDir } from "../helpers/tmp.ts";

/**
 * Runs `startup`, then the report step and a stand-in for `exec codex`, in `cwd` with `env`.
 * Returns the report path, whether the stand-in ran, and the shell's exit status.
 */
function launch(startup: string, env: NodeJS.ProcessEnv, cwd = realpathSync(tempDir())) {
  const report = join(tempDir("elwood-codex-report-"), "codex-home");
  const script = `${startup}\n${reportCodexHomeCommand(report)}; echo codex-launched`;
  const result = spawnSync("/bin/sh", ["-c", script], { cwd, env, encoding: "utf8" });
  return { report, launched: result.stdout === "codex-launched\n", status: result.status };
}

function configPath(report: string): Promise<string> {
  return reportedCodexConfigPath(report, AbortSignal.timeout(2_000));
}

/** A real directory with a space in its name, as Codex requires its home to exist. */
function codexHome(name = "codex home"): string {
  const home = join(realpathSync(tempDir("elwood-codex-home-")), name);
  mkdirSync(home);
  return home;
}

const home = "/Users/elwood-test";

describe("the launch shell's CODEX_HOME report", () => {
  test("an exported CODEX_HOME, spaces and all, is the one Codex runs with", async () => {
    const exported = codexHome("my  codex home");
    const { report, launched } = launch(`export CODEX_HOME='${exported}'`, { HOME: home });
    expect(launched).toBe(true);
    expect(await configPath(report)).toBe(join(exported, "config.toml"));
  });

  test("a relative CODEX_HOME resolves from the directory Codex starts in", async () => {
    const cwd = realpathSync(tempDir());
    mkdirSync(join(cwd, "relative"));
    const { report } = launch("export CODEX_HOME=relative", { HOME: home }, cwd);
    expect(await configPath(report)).toBe(join(cwd, "relative", "config.toml"));
  });

  test.each([
    ["named by its link", true],
    ["named physically", false],
  ])("from a symlinked directory %s, `..` in a relative CODEX_HOME follows the link first", async (_name, logical) => {
    const real = join(realpathSync(tempDir()), "worktrees", "feature");
    mkdirSync(join(real, "..", "codex"), { recursive: true });
    mkdirSync(real);
    const link = join(realpathSync(tempDir()), "feature-link");
    symlinkSync(real, link);
    // A shell that entered the directory through the link exports that name as `PWD`.
    const env = logical ? { HOME: home, PWD: link } : { HOME: home };
    const { report } = launch("export CODEX_HOME=../codex", env, link);
    const physical = join(real, "..", "codex", "config.toml");
    expect(await configPath(report)).toBe(physical);
    expect(physical).not.toBe(join(resolve(link, "../codex"), "config.toml"));
  });

  test("a startup file that changes directory moves where a relative CODEX_HOME resolves", async () => {
    const elsewhere = realpathSync(tempDir());
    mkdirSync(join(elsewhere, "codex"));
    const { report } = launch(`cd '${elsewhere}'; export CODEX_HOME=codex`, { HOME: home });
    expect(await configPath(report)).toBe(join(elsewhere, "codex", "config.toml"));
  });

  test("a symlinked CODEX_HOME is canonicalized, as Codex does", async () => {
    const target = codexHome();
    const link = join(realpathSync(tempDir()), "codex-link");
    symlinkSync(target, link);
    const { report } = launch(`export CODEX_HOME='${link}'`, { HOME: home });
    expect(await configPath(report)).toBe(join(target, "config.toml"));
  });

  test("an assignment the startup file did not export never reaches Codex", async () => {
    const { report } = launch("CODEX_HOME=/not/exported", { HOME: home });
    expect(await configPath(report)).toBe(join(home, ".codex", "config.toml"));
  });

  test("a HOME with spaces in it arrives whole when CODEX_HOME is unset", async () => {
    const { report } = launch("unset CODEX_HOME", { HOME: "/Users/with  two spaces" });
    expect(await configPath(report)).toBe("/Users/with  two spaces/.codex/config.toml");
  });

  test("a relative HOME, with CODEX_HOME unset, is found from the directory Codex starts in", async () => {
    const cwd = realpathSync(tempDir());
    const { report } = launch("unset CODEX_HOME", { HOME: "relative  home" }, cwd);
    expect(await configPath(report)).toBe(`${cwd}/relative  home/.codex/config.toml`);
  });

  test("an empty CODEX_HOME falls back to $HOME/.codex, and an empty HOME to the account's", async () => {
    const { report } = launch("export CODEX_HOME=", { HOME: "" });
    expect(await configPath(report)).toBe(join(userInfo().homedir, ".codex", "config.toml"));
  });

  test("a wait for a report that never comes names it only in a typed reason", async () => {
    const report = join(tempDir("elwood-codex-report-"), "codex-home");
    const closed = new Error("closed");
    await expect(reportedCodexConfigPath(report, AbortSignal.abort(closed))).rejects.toBe(closed);
    const deadline = elwoodError("model_automation_failed", "Timed out.", { timeoutMs: 1 });
    await expect(
      reportedCodexConfigPath(report, AbortSignal.abort(deadline)),
    ).rejects.toMatchObject({
      code: "model_automation_failed",
      message: "Timed out.",
      details: { timeoutMs: 1, path: report },
    });
  });

  test("Codex does not start when the report cannot be written, and the shell says why", () => {
    const cwd = realpathSync(tempDir());
    const report = join(cwd, "missing-dir", "codex-home");
    const script = `${reportCodexHomeCommand(report)}; echo codex-launched`;
    const result = spawnSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8" });
    expect(result.stdout).toBe("");
    expect(result.status).toBe(reportFailedStatus);
  });

  test("a report path with a quote in it is written where it says", async () => {
    const dir = join(realpathSync(tempDir()), "it's here");
    mkdirSync(dir);
    const report = join(dir, "codex-home");
    const exported = codexHome();
    const script = `${reportCodexHomeCommand(report)}; echo codex-launched`;
    spawnSync("/bin/sh", ["-c", script], { env: { CODEX_HOME: exported }, encoding: "utf8" });
    expect(await configPath(report)).toBe(join(exported, "config.toml"));
  });
});
