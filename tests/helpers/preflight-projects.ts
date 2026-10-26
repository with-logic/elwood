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

/** A launch the PTY factory was asked for; it never starts one. */
export type Launch = { readonly command: string; readonly cwd: string | undefined };

/** Installs the stand-in shell and a PTY factory that records each launch. */
export function useProbeProjects(): Launch[] {
  const launches: Launch[] = [];
  beforeEach(() => {
    setPlatformForTests("darwin");
    setUpdateCoordinatorForTests((_adapter, update) => update()); // never the account's lease
    setPtyFactoryForTests((options) => {
      launches.push({ command: options.args.join(" "), cwd: options.cwd });
      throw new Error("no PTY in this test");
    });
    const home = dir("elwood-preflight-home-");
    // A directory holding `gone-on-login` is removed by the shell's startup, after it started there.
    const startup = '[ -e gone-on-login ] && rm -rf "$PWD"\nexport PATH="$PWD/bin:$PATH"\n';
    writeFileSync(join(home, ".profile"), `echo startup noise\n${startup}`);
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

/**
 * A project directory whose `bin/<cli>` prints `version`, and `help` for `--help`; its `update`
 * records the directory it ran in, in `updated-in`.
 */
export function project(cli: ElwoodAgentKind, version: string, help = ""): string {
  const cwd = dir("elwood-preflight-session-");
  const bin = join(cwd, "bin", cli);
  mkdirSync(join(cwd, "bin"));
  const answers = `--version) echo '${version}' ;; --help) echo '${help}' ;; update) pwd >> updated-in ;;`;
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in ${answers} esac\n`);
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
 * Removes `cwd` once the probe running `command` (`codex --help`, say) has run there. Given a
 * `replacement`, a different directory that holds the same CLI, puts it in `cwd`'s place, so
 * only which directory `cwd` names has changed.
 */
export function changeAfterProbe(cwd: string, command: string, replacement?: string): void {
  const probe = currentCommandRunner();
  setCommandRunnerForTests(async (shell, args, options) => {
    const result = await probe(shell, args, options);
    if (args.at(-1)?.includes(`exec ${command} `)) {
      setCommandRunnerForTests(probe);
      changeDirectory(cwd, replacement);
    }
    return result;
  });
}

/** Removes `cwd`, and puts `replacement`, when given, in its place. */
export function changeDirectory(cwd: string, replacement?: string): void {
  rmSync(cwd, { recursive: true });
  if (replacement !== undefined) renameSync(replacement, cwd);
}

/**
 * How a launch whose directory was removed as its CLI was probed fails (C-API-61, C-PTY-08):
 * as that directory, with the probe's own failure as the cause, never "not found on PATH". A
 * directory made again in its place has no `errno` of its own, and keeps none of the probe's.
 */
export const directoryLossCases = [
  {
    how: "removed",
    remade: false,
    message: "The working directory (`cwd`) is not an existing directory.",
    errno: "ENOENT",
  },
  {
    how: "removed and made again",
    remade: true,
    message: "The working directory (`cwd`) was replaced by another directory.",
    errno: undefined,
  },
] as const;

/**
 * Matches the error of a launch that lost `cwd`, `as` one of `directoryLossCases`. Its
 * `details` must equal these exactly.
 */
export function lostDirectoryFailure(
  agent: ElwoodAgentKind,
  cwd: string,
  as: Pick<(typeof directoryLossCases)[number], "message" | "errno">,
  cause: unknown = expect.stringMatching(/^spawn .* ENOENT$/), // the shell could not start there
): unknown {
  return expect.objectContaining({
    code: `${agent}_start_failed`,
    message: as.message,
    details: { cwd, cause, ...(as.errno ? { errno: as.errno } : {}) },
  });
}

/** Persists a resumable record for a session that launched in `cwd`; returns its state dir. */
export function createResumableSessionStateDir(adapter: SessionAdapter, cwd: string): string {
  return resumableStateDir(adapter, cwd, `${adapter}-probe-cwd`);
}

export const oldCodex = { code: "codex_version_unsupported", details: { version: "0.100.0" } };
export const oldClaude = { code: "claude_version_unsupported", details: { found: "2.1.100" } };

/** The flag Codex is launched with only when its `--help` lists it (§4.2). */
export const hookTrustBypass = "--dangerously-bypass-hook-trust";

/** Whether each launch passed the hook-trust bypass, and the directory it launched in. */
export function bypassByDirectory(launches: readonly Launch[]) {
  return launches.map(({ command, cwd }) => [cwd, command.includes(hookTrustBypass)]);
}
