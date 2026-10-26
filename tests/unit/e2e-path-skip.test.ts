/**
 * The e2e availability probe finds a CLI as the user's login shell does, and its program path
 * apart from anything else the shell prints (PRD §12, C-E2E-04). A CLI the login shell resolves
 * only as a function has no program path, so a test that needs one skips rather than run with
 * the function's name as a path. Each test probes a real login shell, the user's own, whose
 * startup files come from a private HOME and ZDOTDIR, so the developer's own are never read.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userShell } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * The availability helper, loaded fresh in a run of its own, whose login shell runs `profile`
 * after resetting PATH to the system's own directories, where no CLI lives.
 */
function availabilityAfter(profile: string) {
  const home = tempDir("elwood-e2e-home-");
  const startup = `export PATH=/usr/bin:/bin\n${profile}\n`;
  writeFileSync(join(home, ".zshrc"), startup);
  writeFileSync(join(home, ".bash_profile"), startup);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZDOTDIR", home);
  vi.stubEnv("TERM_PROGRAM", ""); // no /etc/zshrc_Apple_Terminal session hooks
  vi.stubEnv("ELWOOD_E2E_RUN_DIR", tempDir("elwood-e2e-run-"));
  vi.stubEnv("ELWOOD_E2E_SKIP_CLAUDE", "");
  vi.resetModules();
  return import("../e2e/availability.ts");
}

const loginShells = ["zsh", "bash"];

describe.skipIf(!loginShells.includes(basename(userShell())))("the user's login shell", () => {
  test("C-E2E-04 a CLI found only as a function has no path, so a test needing one skips", async () => {
    const { pathSkipReason, resolvedAgentPath, skipReason } = await availabilityAfter(
      "claude() { echo claude; }",
    );
    expect(skipReason("claude")).toBeUndefined();
    // The function's name is no path: a test would have put its directory, ".", on PATH.
    expect(() => resolvedAgentPath("claude")).toThrow(/only as a login-shell function/);
    expect(pathSkipReason("claude")).toBe(
      "claude resolves only as a login-shell function, with no program path",
    );
  }, 60_000);

  test("C-E2E-04 a CLI found as a program has that program's path, whatever the profile prints", async () => {
    const bin = tempDir("elwood-e2e-bin-");
    mkdirSync(join(bin, "sub"));
    const program = join(bin, "sub", "claude");
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o755);
    const { pathSkipReason, resolvedAgentPath } = await availabilityAfter(
      // Printed before and after the lookup: the EXIT trap's line would come last.
      `export PATH=${join(bin, "sub")}:"$PATH"; echo noise; echo noise >&2; trap 'echo noise' EXIT`,
    );
    expect(resolvedAgentPath("claude")).toBe(program);
    expect(pathSkipReason("claude")).toBeUndefined();
  }, 60_000);

  test("C-E2E-04 a CLI the login shell cannot find skips every test that needs it", async () => {
    const { pathSkipReason, skipReason } = await availabilityAfter("true");
    expect(skipReason("claude")).toMatch(/^claude CLI does not resolve in the login shell /);
    expect(pathSkipReason("claude")).toBe(skipReason("claude"));
  }, 60_000);
});
