/**
 * Real preflight probes through a stand-in login shell whose startup file, in a private HOME,
 * prints noise and puts `$PWD/bin` first on a PATH that holds no `claude` or `codex` of its
 * own, as a per-directory tool manager does. Each project directory carries its own fake CLI,
 * so only a probe that starts in that directory can find it. Shared by the PRD §4.2 / C-PTY-08
 * preflight tests.
 */

import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import {
  currentCommandRunner,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
} from "../../src/runtime/update/once.ts";
import { useStandInLoginShell } from "./login-shell.ts";
import { resumableStateDir, type SessionAdapter } from "./session-state.ts";
import { tempDir } from "./tmp.ts";

/** A launch the PTY factory was asked for; it never starts one. */
export type Launch = { readonly command: string; readonly cwd: string | undefined };

/** Installs the stand-in shell and a recording PTY factory around each test. */
export function useProbeProjects(): Launch[] {
  const savedEnv = { ...process.env };
  const launches: Launch[] = [];
  beforeEach(() => {
    setPlatformForTests("darwin");
    setPtyFactoryForTests((options) => {
      launches.push({ command: options.args.join(" "), cwd: options.cwd });
      throw new Error("no PTY in this test");
    });
    const home = dir("elwood-preflight-home-");
    writeFileSync(join(home, ".profile"), 'echo startup noise\nexport PATH="$PWD/bin:$PATH"\n');
    process.env["HOME"] = home;
    // No global CLI: a probe that ignores the project directory finds none.
    process.env["PATH"] = "/usr/bin:/bin";
    useStandInLoginShell(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeSeamsForTests();
    resetPreflightCacheForTests();
    resetCodexPreflightCacheForTests();
    resetAutoupdateForTests();
    launches.length = 0;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  return launches;
}

/** A real directory; the shell reports `$PWD` physically (macOS tmpdir is a symlink). */
export function dir(prefix: string): string {
  return realpathSync(tempDir(prefix));
}

/** A project directory whose `bin/<cli>` prints `version` and `help`. */
export function project(cli: ElwoodAgentKind, version: string, help = ""): string {
  const cwd = dir("elwood-preflight-session-");
  const bin = join(cwd, "bin", cli);
  mkdirSync(join(cwd, "bin"));
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1" in --version) echo '${version}' ;; --help) echo '${help}' ;; esac\n`,
  );
  chmodSync(bin, 0o755);
  return cwd;
}

/**
 * Removes `cwd` as the first probe is about to spawn, after the launch's own check of it passed,
 * then runs that probe for real. Given a `replacement` directory, made while `cwd` still existed
 * so it is a different one, moves it into `cwd`'s place once that probe has failed.
 */
export function removeWhenProbed(cwd: string, replacement?: string): void {
  const probe = currentCommandRunner();
  let removed = false;
  setCommandRunnerForTests(async (command, args, options) => {
    if (removed) return probe(command, args, options);
    removed = true;
    rmSync(cwd, { recursive: true, force: true });
    const result = await probe(command, args, options);
    if (replacement !== undefined) renameSync(replacement, cwd);
    return result;
  });
}

/** How a start or resume whose directory was removed as its CLI was probed fails (C-API-61). */
export const directoryLossCases = [
  {
    how: "removed",
    remade: false,
    message: "The working directory (`cwd`) is not an existing directory.",
    errno: { errno: "ENOENT" },
  },
  {
    how: "removed and made again",
    remade: true,
    message: "The working directory (`cwd`) was replaced by another directory.",
    errno: {},
  },
] as const;

/** Persists a resumable record for a session that launched in `cwd`; returns its state dir. */
export function createResumableSessionStateDir(adapter: SessionAdapter, cwd: string): string {
  return resumableStateDir(adapter, cwd, `${adapter}-probe-cwd`);
}

export const oldCodex = { code: "codex_version_unsupported", details: { version: "0.100.0" } };
export const oldClaude = { code: "claude_version_unsupported", details: { found: "2.1.100" } };
export const codexHookTrustBypassFlag = "--dangerously-bypass-hook-trust";
