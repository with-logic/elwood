/**
 * Where the e2e CLI home guard's stop surfaces (PRD §12, C-E2E-24). A probe runs the guard
 * after its start line, and a probe the guard stops, by either probe command form, is a
 * login-shell failure that carries only the guard's fixed reason, never the shell's stderr.
 * A login shell that fails before the start line is still the login shell's own failure
 * (C-PERF-05). A session whose login shell the guard stops during startup fails with a start
 * error that names the guard. The suite's registry never trusts a list its process inherited.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { probeFailureDetails } from "../../src/core/errors.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { announcesStart } from "../../src/runtime/probe/start.ts";
import {
  homeGuardHomesKey,
  homeGuardStoppedReason,
  probeShellCommand,
  probeShellStatus,
} from "../../src/runtime/shell.ts";
import { assertStartupUsable } from "../../src/runtime/startup/index.ts";
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
const stopped = { message: homeGuardStoppedReason, phase: "login_shell", shellStatus: 97 };

test("C-E2E-24 a guarded probe still announces its start", () => {
  guardWith(":");
  expect(announcesStart(probeShellCommand("codex --version"))).toBe(true);
  expect(announcesStart(probeShellStatus("command -v codex"))).toBe(true);
});

describe.each(loginShells)("C-E2E-24 a guarded probe (%s)", (shell) => {
  test.each([
    ["with output", probeShellCommand],
    ["by status only", probeShellStatus],
  ])("the guard stops, %s, is a login-shell failure with only the guard's reason", async (_case, probe) => {
    guardWith('echo "secret=$HOME" >&2; export CODEX_HOME="$HOME"');
    const result = await runProbe(shell, probe(command));
    expect(result).toMatchObject({ status: null, error: stopped });
    expect(result.stdout).not.toContain("command ran");
    expect(probeFailureDetails(result)).toEqual({
      stderr: "",
      cause: homeGuardStoppedReason,
      phase: "login_shell",
    });
  });

  test("whose login shell exits before its start line is the login shell's failure", async () => {
    guardWith("exit 3");
    const result = await runProbe(shell, probeShellCommand(command));
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ phase: "login_shell", shellStatus: 3 });
  });

  test("whose own command exits 97 while the guard is off is the command's failure", async () => {
    guardWith(":", () => "");
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

describe("C-E2E-24 a session whose login shell exits during startup", () => {
  const started = (exitCode: number) =>
    assertStartupUsable({ adapter: "codex", exit: { exitCode }, output: "", waitMs: 0 });

  test("with the guard's status, while the guard is on, fails naming the guard", async () => {
    vi.stubEnv(homeGuardHomesKey, "[]");
    await expect(started(97)).rejects.toMatchObject({
      code: "codex_start_failed",
      message: `codex exited during startup: ${homeGuardStoppedReason}.`,
      details: { exitCode: 97 },
    });
  });

  test.each([
    ["any other status, while the guard is on", "[]", 1],
    ["the guard's status, while the guard is off", undefined, 97],
  ])("with %s, fails as before", async (_case, list, exitCode) => {
    vi.stubEnv(homeGuardHomesKey, list);
    await expect(started(exitCode)).rejects.toMatchObject({
      code: "codex_start_failed",
      message: "codex exited during startup.",
      details: { exitCode },
    });
  });
});
