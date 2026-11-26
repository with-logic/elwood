/**
 * Runs an older Claude the user already has installed, for proofs that need a version before
 * the one on `PATH` (PRD §12, C-E2E-28). The version stays the user's own native install under
 * `~/.local/share/claude/versions`; a private directory holds the only `claude` link to it, and
 * both the version probe and the session's login shell put that directory first on `PATH`,
 * after the user's profile has run, so they resolve the same binary (C-PTY-08). Claude's own
 * updater is off for these launches, so an older Claude never replaces the user's install.
 */

import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, parseVersion } from "../../src/core/versions.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { privateTempDir, removeOrReport } from "../helpers/private-temp.ts";
import { userConfigDir } from "./claude-home.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";

const versionsDir = join(homedir(), ".local/share/claude/versions");

/** The newest installed native Claude at or above `floor` and below `before`, if there is one. */
export function installedClaudeBefore(before: string, floor: string): string | undefined {
  if (!existsSync(versionsDir)) return undefined;
  return readdirSync(versionsDir)
    .filter((name) => parseVersion(name) === name)
    .filter((name) => compareVersions(name, floor) >= 0 && compareVersions(name, before) < 0)
    .sort(compareVersions)
    .at(-1);
}

/**
 * Points Elwood's version probe and PTY launches at installed Claude `version` until the
 * returned restore runs, which resets the seams and removes the private directory.
 */
export function pinInstalledClaude(version: string): () => void {
  const bin = privateTempDir("elwood_pinned_claude-", userConfigDir, "Claude config dir");
  symlinkSync(join(versionsDir, version), join(bin, "claude"));
  const pin = (args: readonly string[]) =>
    prefixShellArgument(args, `export DISABLE_AUTOUPDATER=1 PATH=${shellQuote(bin)}:"$PATH"`);
  setCommandRunnerForTests((command, args, options) => runProbe(command, pin(args), options));
  setPtyFactoryForTests((options) => nodePtyFactory({ ...options, args: pin(options.args) }));
  return () => {
    resetRuntimeSeamsForTests();
    removeOrReport(bin, "pinned Claude directory");
  };
}
