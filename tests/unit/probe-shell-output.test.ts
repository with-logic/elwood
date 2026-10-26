/**
 * The real zsh login shell's startup and exit output never reaches a probe's captured output, so
 * it cannot leak into `agent_update_failed`, `version_unparseable`, or a `*_start_failed` error's
 * details (PRD §9.2, C-PERF-05, C-LIFE-11, C-ERR-07, C-ERR-08). A private ZDOTDIR holds the
 * startup files, so the developer's own are never read.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { runProbe, setProbeTimeoutsForTests } from "../../src/runtime/probe/index.ts";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { pollGone } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

const zsh = "/bin/zsh";
/** Private startup files: `.zshrc` runs before the probe's script, `.zlogout` after it. */
type Profile = { readonly rc: string; readonly logout: string };
const silent: Profile = { rc: "", logout: "" };
/** Startup output on both streams before the command, and exit output after it. */
const leaky: Profile = {
  rc: [
    "echo FAKE-SECRET-rc-out; echo FAKE-SECRET-rc-err >&2",
    "trap 'echo FAKE-SECRET-trap-out; echo FAKE-SECRET-trap-err >&2' EXIT",
    // Runs only if a bound's signal could be trapped: it would print before the end line.
    "TRAPTERM() { echo FAKE-SECRET-term; echo FAKE-SECRET-term >&2 }",
  ].join("\n"),
  logout: "echo FAKE-SECRET-logout >&2",
};

/** A real zsh login shell with private startup files and fake CLIs on its PATH. */
function zshProfile(profile: Profile, clis: Readonly<Record<string, string>> = {}): string {
  const root = tempDir("elwood-zsh-output-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(clis))
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const path = `export PATH=${shell.shellQuote(bin)}:"$PATH"`;
  writeFileSync(join(root, ".zshrc"), `${path}\n${profile.rc}\n`);
  writeFileSync(join(root, ".zlogout"), `${profile.logout}\n`);
  vi.stubEnv("ZDOTDIR", root);
  vi.stubEnv("TERM_PROGRAM", ""); // no /etc/zshrc_Apple_Terminal session hooks
  vi.spyOn(shell, "userShell").mockReturnValue(zsh);
  setPlatformForTests("darwin");
  return root;
}

beforeEach(() => {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setProbeTimeoutsForTests({ commandMs: 30_000, launchMs: 30_000 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!existsSync(zsh))("real zsh login shell", () => {
  test.each([
    ["", leaky],
    [" under errexit", { ...leaky, rc: `${leaky.rc}\nsetopt errexit` }],
  ])(
    "C-LIFE-11 a failed update's warning carries only the updater's own stderr%s",
    async (_, profile) => {
      const update = "echo 'update failed: network' >&2; exit 1";
      zshProfile(profile, { claude: `[ "$1" = update ] && { ${update}; }; echo 2.1.310` });
      const warning = await preflightClaude(false, true);
      expect(warning).toMatchObject({
        code: "agent_update_failed",
        raw: "update failed: network\n",
      });
      expect(JSON.stringify(warning)).not.toContain("FAKE-SECRET");
    },
    60_000,
  );

  test("C-ERR-07 an unparseable version's warning carries only the CLI's own stdout", async () => {
    zshProfile(leaky, { claude: "printf 'not a version'" }); // no trailing newline
    const warning = await preflightClaude(false);
    expect(warning).toMatchObject({ code: "version_unparseable", raw: "not a version" });
  }, 60_000);

  test("C-ERR-08 a failed version probe's details carry only the CLI's own stderr", async () => {
    zshProfile(leaky, { claude: "echo 'broken install' >&2; exit 3" });
    const failure = await preflightClaude(false).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "claude_start_failed" });
    expect(failure).toHaveProperty("details.stderr", "broken install\n");
    expect(JSON.stringify(failure)).not.toContain("FAKE-SECRET");
  }, 60_000);

  test("C-PERF-03 a timed-out command keeps its own output and its exact pid is gone", async () => {
    const pidFile = join(zshProfile(leaky), "command.pid");
    setProbeTimeoutsForTests({ commandMs: 3_000, launchMs: 30_000 });
    const command = `printf out; printf err >&2; echo $$ > "${pidFile}"; exec sleep 30`;
    const script = `/bin/sh -c ${shell.shellQuote(command)}`;
    const result = await runProbe(zsh, shell.probeShellCommand(script));
    expect(result).toMatchObject({ status: null, stdout: "out", stderr: "err" });
    expect(result.error?.code).toBe("ETIMEDOUT");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await pollGone({ pid, timeoutMs: 5_000 })).toBe(true);
  }, 60_000);

  test.each([
    ["printf 2.1.310", { status: 0, stdout: "2.1.310", stderr: "" }],
    ["/bin/sh -c 'kill -TERM $$'", { status: 143, stdout: "", stderr: "" }],
  ])(
    "C-PERF-05 a silent profile keeps the exact output and exit status of `%s`",
    async (command, expected) => {
      zshProfile(silent);
      expect(await runProbe(zsh, shell.probeShellCommand(command))).toEqual(expected);
    },
    60_000,
  );

  test("C-PERF-05 every Codex probe still parses through a silent profile", async () => {
    const help = "echo '  --dangerously-bypass-hook-trust  Skip hook trust'";
    zshProfile(silent, { codex: `[ "$1" = --help ] && ${help} || echo 'codex-cli 0.164.0'` });
    await expect(preflightCodex(true, true)).resolves.toBeUndefined();
    await expect(detectCodexCliCapabilities()).resolves.toEqual({ supportsHookTrustBypass: true });
  }, 60_000);
});
