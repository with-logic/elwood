/**
 * Real preflight probes through a stand-in login shell whose startup file, in a private HOME,
 * prints noise and puts `$PWD/bin` first on a PATH that holds no `claude` or `codex` of its
 * own, as a per-directory tool manager does. Each project directory carries its own fake CLI,
 * so only a probe that starts in that directory can find it. Shared by the PRD §4.2 / C-PTY-08
 * preflight tests.
 */

import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import {
  currentCommandRunner,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { useStandInLoginShell } from "./login-shell.ts";
import { resumableStateDir, type SessionAdapter } from "./session-state.ts";
import { tempDir } from "./tmp.ts";

/** Installs the stand-in shell and a PTY factory that records each launch's `cwd`. */
export function useProbeProjects(): (string | undefined)[] {
  const launches: (string | undefined)[] = [];
  beforeEach(() => {
    setPlatformForTests("darwin");
    setUpdateCoordinatorForTests((_adapter, update) => update()); // never the account's lease
    setPtyFactoryForTests((options) => {
      launches.push(options.cwd);
      throw new Error("no PTY in this test");
    });
    const home = dir("elwood-preflight-home-");
    writeFileSync(join(home, ".profile"), 'echo startup noise\nexport PATH="$PWD/bin:$PATH"\n');
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "/usr/bin:/bin"); // no global CLI: a probe elsewhere finds none
    useStandInLoginShell(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPreflightCacheForTests();
    resetCodexPreflightCacheForTests();
    resetAutoupdateForTests();
    launches.length = 0;
  });
  return launches;
}

/** A real directory; the shell reports `$PWD` physically (macOS tmpdir is a symlink). */
export function dir(prefix: string): string {
  return realpathSync(tempDir(prefix));
}

/** A project directory whose `bin/<cli>` prints `version`. */
export function project(cli: ElwoodAgentKind, version: string): string {
  const cwd = dir("elwood-preflight-session-");
  const bin = join(cwd, "bin", cli);
  mkdirSync(join(cwd, "bin"));
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo '${version}' ;; esac\n`);
  chmodSync(bin, 0o755);
  return cwd;
}

/**
 * Removes `cwd` as the first probe is about to spawn, after the launch's own check of it passed,
 * then runs that probe for real. Given a `replacement`, made while `cwd` still existed so it is
 * a different directory, moves it into `cwd`'s place once that probe has failed.
 */
export function removeWhenProbed(cwd: string, replacement?: string): void {
  const probe = currentCommandRunner();
  setCommandRunnerForTests(async (command, args, options) => {
    setCommandRunnerForTests(probe);
    rmSync(cwd, { recursive: true, force: true });
    const result = await probe(command, args, options);
    if (replacement !== undefined) renameSync(replacement, cwd);
    return result;
  });
}

/**
 * How a launch whose directory was removed as its CLI was probed fails (C-API-61, C-PTY-08):
 * as that directory, with the probe's own failure as the cause, never "not found on PATH".
 */
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

/** The details a launch that lost `cwd` while it was probed fails with. */
export function lostDirectory(cwd: string, errno: Readonly<Record<string, string>>) {
  // The probe could not start its shell there.
  return { cwd, cause: expect.stringMatching(/^spawn .* ENOENT$/), ...errno };
}

/** Persists a resumable record for a session that launched in `cwd`; returns its state dir. */
export function createResumableSessionStateDir(adapter: SessionAdapter, cwd: string): string {
  return resumableStateDir(adapter, cwd, `${adapter}-probe-cwd`);
}

export const oldCodex = { code: "codex_version_unsupported", details: { version: "0.100.0" } };
export const oldClaude = { code: "claude_version_unsupported", details: { found: "2.1.100" } };
