/**
 * The e2e availability probe finds a CLI as the user's login shell does, and its program path
 * apart from anything else the shell prints (PRD §12, C-E2E-04). A CLI the login shell resolves
 * but not to a program on its PATH, as a function or an alias, has no program path, so a test
 * that needs one skips rather than run with its name as a path. Each test probes a real login
 * shell, the user's own, whose startup files come from a private HOME and ZDOTDIR, so the
 * developer's own are never read, and whose PATH starts as an empty directory of the test's own,
 * so no CLI installed on the host is found.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { homeGuardHomesKey } from "../../src/runtime/home-guard/index.ts";
import { shellQuote, userShell } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * One real interactive login shell per test, with a private profile of a line or two: seconds
 * even on a loaded host, far inside this.
 */
const loginShellTestMs = 60_000;

/**
 * The availability helper, loaded fresh in a run of its own, whose login shell runs `profile`
 * after setting PATH to an empty directory, where no CLI lives.
 */
function availabilityAfter(profile: string) {
  const home = tempDir("elwood-e2e-home-");
  const startup = `export PATH=${shellQuote(tempDir("elwood-e2e-path-"))}\n${profile}\n`;
  writeFileSync(join(home, ".zshrc"), startup);
  writeFileSync(join(home, ".bash_profile"), startup);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZDOTDIR", home);
  vi.stubEnv("TERM_PROGRAM", ""); // no /etc/zshrc_Apple_Terminal session hooks
  vi.stubEnv(homeGuardHomesKey, ""); // no home guard, whose `printenv` the empty PATH would hide
  vi.stubEnv("ELWOOD_E2E_RUN_DIR", tempDir("elwood-e2e-run-"));
  vi.stubEnv("ELWOOD_E2E_SKIP_CLAUDE", "");
  vi.resetModules();
  return import("../e2e/availability.ts");
}

const loginShells = ["zsh", "bash"];

describe.skipIf(!loginShells.includes(basename(userShell())))("the user's login shell", () => {
  test.each([
    ["a function", "claude() { echo claude; }"],
    ["an alias", "alias claude='echo claude'"],
  ])(
    "C-E2E-04 a CLI found only as %s has no path, so a test needing one skips",
    async (_, definition) => {
      const { pathSkipReason, resolvedAgentProgramPath, skipReason } =
        await availabilityAfter(definition);
      expect(skipReason("claude")).toBeUndefined();
      // Its name is no path: a test would have put its directory, ".", on PATH.
      expect(() => resolvedAgentProgramPath("claude")).toThrow(/not to a program on its PATH/);
      expect(pathSkipReason("claude")).toBe(
        "claude resolves in the login shell, but not to a program on its PATH",
      );
    },
    loginShellTestMs,
  );

  test(
    "C-E2E-04 a CLI found as a program has that program's path, whatever the profile prints",
    async () => {
      const bin = tempDir("elwood-e2e-bin-");
      mkdirSync(join(bin, "sub"));
      const program = join(bin, "sub", "claude");
      writeFileSync(program, "#!/bin/sh\n");
      chmodSync(program, 0o755);
      const { pathSkipReason, resolvedAgentProgramPath } = await availabilityAfter(
        // Printed before and after the lookup: the EXIT trap's line would come last.
        `export PATH=${join(bin, "sub")}:"$PATH"; echo noise; echo noise >&2; trap 'echo noise' EXIT`,
      );
      expect(resolvedAgentProgramPath("claude")).toBe(program);
      expect(pathSkipReason("claude")).toBeUndefined();
    },
    loginShellTestMs,
  );

  test(
    "C-E2E-04 a CLI the login shell cannot find skips every test that needs it",
    async () => {
      const { pathSkipReason, skipReason } = await availabilityAfter("true");
      expect(skipReason("claude")).toMatch(/^claude CLI does not resolve in the login shell /);
      expect(pathSkipReason("claude")).toBe(skipReason("claude"));
    },
    loginShellTestMs,
  );
});
