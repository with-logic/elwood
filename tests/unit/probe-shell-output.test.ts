/** Real profile hooks never become command output or warning diagnostics (PRD §9.2, C-PERF-05). */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

const leaks = {
  startup: "echo FAKE-SECRET; echo FAKE-SECRET >&2",
  EXIT: "trap 'echo FAKE-SECRET; echo FAKE-SECRET >&2' EXIT",
  DEBUG: "TRAPDEBUG() { echo FAKE-SECRET; echo FAKE-SECRET >&2 }",
  ZERR: "TRAPZERR() { echo FAKE-SECRET; echo FAKE-SECRET >&2 }",
  "exec wrapper": 'function exec() { echo FAKE-SECRET-exec >&2; builtin exec "$@"; }',
  background: "( sleep 0.2; echo FAKE-SECRET; echo FAKE-SECRET >&2 ) &!",
};
const logout = "echo FAKE-SECRET; echo FAKE-SECRET >&2";
const combined = `${Object.values(leaks).join("\n")}\nsetopt errexit`;

/** A private startup directory and optional fake CLI, without the developer’s profile. */
function profile(rc: string, claude?: string): string {
  const root = tempDir("elwood-profile-output-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (claude !== undefined)
    writeFileSync(join(bin, "claude"), `#!/bin/sh\n${claude}\n`, { mode: 0o700 });
  writeFileSync(join(root, ".zshrc"), `export PATH=${shell.shellQuote(bin)}:"$PATH"\n${rc}\n`);
  writeFileSync(join(root, ".zlogout"), logout);
  vi.stubEnv("ZDOTDIR", root);
  vi.stubEnv("TERM_PROGRAM", "");
  vi.spyOn(shell, "userShell").mockReturnValue("/bin/zsh");
  return root;
}

beforeEach(() => {
  resetPreflightCacheForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  setPlatformForTests("darwin");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!existsSync("/bin/zsh"))("private zsh profile", () => {
  test.each(
    Object.entries({ ...leaks, combined }),
  )("C-PERF-05 excludes profile output from stdout and stderr (%s)", async (_name, rc) => {
    profile(rc);
    const command = `/bin/sh -c ${shell.shellQuote("sleep 0.3; echo wanted; echo own-error >&2; exit 3")}`;
    expect(await runProbe("/bin/zsh", shell.probeShellCommand(command))).toEqual({
      status: 3,
      stdout: "wanted\n",
      stderr: "own-error\n",
    });
  });

  test("C-LIFE-11 failed update warnings retain only the updater’s stderr", async () => {
    profile(
      combined,
      '[ "$1" = update ] && { sleep 0.3; echo update-error >&2; exit 3; }; echo 2.1.310',
    );
    const warning = await preflightClaude(false, true);
    expect(warning).toMatchObject({ code: "agent_update_failed", raw: "update-error\n" });
    expect(JSON.stringify(warning)).not.toContain("FAKE-SECRET");
  });

  test("C-ERR-07 unparseable version warnings retain only CLI stdout", async () => {
    profile(combined, "printf 'not a version'");
    const warning = await preflightClaude(false);
    expect(warning).toMatchObject({ code: "version_unparseable", raw: "not a version" });
    expect(JSON.stringify(warning)).not.toContain("FAKE-SECRET");
  });

  test("C-ERR-08 failed version checks retain only CLI stderr", async () => {
    profile(combined, "echo install-error >&2; exit 3");
    const error = await preflightClaude(false).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "claude_start_failed",
      details: { stderr: "install-error\n" },
    });
    expect(JSON.stringify(error)).not.toContain("FAKE-SECRET");
  });
});
