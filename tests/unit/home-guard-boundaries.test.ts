/**
 * Where the e2e CLI home guard's stop surfaces (PRD §12, C-E2E-24). A probe runs the guard
 * after its start line, and a probe the guard stops, by either probe command form, is a
 * login-shell failure that carries only the guard's fixed reason, never the shell's stderr,
 * even when a startup file redirected that stderr. Only the guard's stop line with its status
 * counts: a command that exits with the same status is still the command's failure. A login
 * shell that fails before the start line is still the login shell's own failure (C-PERF-05).
 * The suite's registry never trusts a list its process inherited. Sessions: `home-guard-startup`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loginShellResolves } from "../../src/cli/request/agent-detect.ts";
import { probeFailureDetails } from "../../src/core/errors.ts";
import { homeGuardHomesKey, homeGuardStoppedReason } from "../../src/runtime/home-guard/index.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { announcesStart } from "../../src/runtime/probe/start.ts";
import type { CommandResult } from "../../src/runtime/seams.ts";
import { loginShellCommand, probeShellCommand, probeShellStatus } from "../../src/runtime/shell.ts";
import { loginShells } from "../helpers/login-shells.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.unstubAllEnvs());

/** A registered `CODEX_HOME`, for login shells whose startup files end in `tail`. */
function guardWith(tail: string, list = (codex: string) => JSON.stringify([codex])): string {
  const codex = join(realpathSync(tempDir("home-guard-probe-")), "codex");
  mkdirSync(codex);
  const home = tempDir("home-guard-probe-home-");
  for (const name of [".zshrc", ".bash_profile", ".profile"])
    writeFileSync(join(home, name), `${tail}\n`);
  vi.stubEnv(homeGuardHomesKey, list(codex));
  vi.stubEnv("CODEX_HOME", codex);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZDOTDIR", undefined);
  vi.stubEnv("CDPATH", undefined);
  return codex;
}

const command = "printf 'command ran\\n'";

/**
 * How a probe the guard stopped after a startup file hid stdout fails. Its stop line goes on the
 * control descriptor, beside its start line. A shell that closed that descriptor, as macOS's bash
 * 3.2 does as a login shell, wrote its start line on the hidden stdout too, so the probe is the
 * login shell's failure by its status alone (C-PERF-05).
 */
function hiddenStdoutStop(shell: string): NonNullable<CommandResult["error"]> {
  const opened = spawnSync(shell, ["-l", "-i", "-c", "{ : >&3; } 2>/dev/null"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  if (opened.status === 0) return stopped;
  const message = "login shell exited with status 97 before starting the probe command";
  return { message, phase: "login_shell", shellStatus: 97 };
}
const stopped: NonNullable<CommandResult["error"]> = {
  message: homeGuardStoppedReason,
  phase: "login_shell",
  shellStatus: 97,
};

test("C-E2E-24 a guarded probe still announces its start, and never writes to a terminal", () => {
  guardWith(":");
  expect(announcesStart(probeShellCommand("codex --version"))).toBe(true);
  expect(announcesStart(probeShellStatus("command -v codex"))).toBe(true);
  // A probe runs in a session of its own, with no terminal to write to.
  vi.stubEnv(homeGuardHomesKey, "not a list");
  expect(loginShellCommand("codex")[3]).toContain("/dev/tty");
  expect(probeShellCommand("codex --version")[3]).not.toContain("/dev/tty");
  expect(probeShellStatus("command -v codex")[3]).not.toContain("/dev/tty");
});

describe.each(loginShells)("C-E2E-24 a guarded probe (%s)", (shell) => {
  test.each([
    ["with output", probeShellCommand],
    ["by status only", probeShellStatus],
  ])("the guard stops, %s, is a login-shell failure with only the guard's reason", async (_case, probe) => {
    guardWith('echo "secret=$HOME" >&2; exec 2>/dev/null; export CODEX_HOME="$HOME"');
    const result = await runProbe(shell, probe(command));
    expect(result).toMatchObject({ status: null, error: stopped });
    expect(result.stdout).not.toContain("command ran");
    expect(probeFailureDetails(result)).toEqual({
      stderr: "",
      cause: homeGuardStoppedReason,
      phase: "login_shell",
    });
  });

  test.each([
    ["with output", probeShellCommand],
    ["by status only", probeShellStatus],
  ])("the guard stops, %s, after a startup file hid stdout, is a login-shell failure", async (_case, probe) => {
    guardWith('exec >/dev/null; export CODEX_HOME="$HOME"');
    const result = await runProbe(shell, probe(command));
    expect(result).toMatchObject({ status: null, error: hiddenStdoutStop(shell) });
  });

  test("stops auto-detection, after a startup file hid stdout, as a failed check", async () => {
    guardWith('exec >/dev/null; export CODEX_HOME="$HOME"');
    await expect(loginShellResolves("codex", shell)).rejects.toMatchObject({
      code: "no_agent_found",
      message: expect.stringContaining(hiddenStdoutStop(shell).message),
    });
  });

  test("whose login shell exits before its start line is the login shell's failure", async () => {
    guardWith("exit 3");
    const result = await runProbe(shell, probeShellCommand(command));
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ phase: "login_shell", shellStatus: 3 });
  });

  test.each([
    ["while the guard is off", () => ""],
    ["under a guard that passes", undefined],
    ["under a list that guards no home", () => JSON.stringify(["/elsewhere"])],
  ])("whose own command exits 97 %s is the command's failure", async (_case, list) => {
    guardWith(":", list);
    const result = await runProbe(shell, probeShellCommand("exit 97"));
    expect(result).toMatchObject({ status: 97 });
    expect(result.error).toBeUndefined();
  });

  test("refuses a home the process inherited as registered, such as the user's own", async () => {
    const userHome = tempDir("home-guard-user-home-");
    const codex = guardWith(`export CODEX_HOME=${userHome}`, () => JSON.stringify([userHome]));
    vi.resetModules();
    const { registerPrivateHome } = await import("../e2e/home-guard.ts");
    registerPrivateHome(codex);
    expect(process.env[homeGuardHomesKey]).toBe(JSON.stringify([codex]));
    const result = await runProbe(shell, probeShellCommand(command));
    expect(result).toMatchObject({ status: null, error: stopped });
  });
});
