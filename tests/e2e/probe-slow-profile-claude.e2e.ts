/**
 * Loading the login shell's startup files is the user's profile, not the CLI: a real Claude
 * session starts when its zsh profile outlasts the probe command's bound, because that
 * bound starts at the shell's start line. Implements PRD §9.2 and C-PERF-05 against the
 * real zsh login shell and the real `claude --version` preflight.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { ClaudeSession, ElwoodError } from "../../src/index.ts";
import { resetProbeTimeoutForTests, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { loginShellCommand, shellQuote, userShell } from "../../src/runtime/shell.ts";
import { e2eTimeoutMs, makeProject, skipIf, skipReason } from "./helpers.ts";

// The profile sleeps twice the command bound. Real `claude --version` answered in at most
// 0.12 s across 16 concurrent runs on a loaded host, so the command bound is ample.
const profileSeconds = 4;
const commandBoundMs = 2_000;

/** The directory the user's real login shell resolves `claude` from. */
function claudeDirectory(): string {
  const resolved = spawnSync(userShell(), [...loginShellCommand("command -v claude")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 75_000,
  });
  return dirname(resolved.stdout.trim());
}

test("C-PERF-05 a real Claude session starts when its login profile outlasts the probe command bound", {
  skip: skipIf(
    skipReason("claude"),
    !userShell().endsWith("/zsh") && "needs zsh for a private ZDOTDIR",
  ),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  // A private ZDOTDIR replaces only the user's startup files: a slow profile that still
  // resolves the same `claude` the user's own shell does.
  const zdotdir = join(project.cwd, "zdotdir");
  mkdirSync(zdotdir);
  writeFileSync(
    join(zdotdir, ".zshrc"),
    `sleep ${profileSeconds}\nexport PATH=${shellQuote(claudeDirectory())}:"$PATH"\n`,
  );
  const previous = process.env["ZDOTDIR"];
  process.env["ZDOTDIR"] = zdotdir;
  setProbeTimeoutMsForTests(commandBoundMs, 60_000);
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  try {
    // Preflight runs `claude --version` through the slow profile before the PTY launches.
    const failure = await session.start().then(
      () => undefined,
      (error: unknown) =>
        error instanceof ElwoodError
          ? `${error.code}: ${error.message} ${JSON.stringify(error.details)}`
          : String(error),
    );
    assert.equal(failure, undefined, `start failed: ${failure}`);
  } finally {
    await session.teardown().catch(() => session.kill());
    if (previous === undefined) delete process.env["ZDOTDIR"];
    else process.env["ZDOTDIR"] = previous;
    resetProbeTimeoutForTests();
  }
});
