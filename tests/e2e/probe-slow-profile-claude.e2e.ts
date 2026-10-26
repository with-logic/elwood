/**
 * Loading the login shell's startup files is the user's profile, not the CLI: a real Claude
 * session starts when its zsh profile outlasts the probe command's bound, because that
 * bound starts at the shell's start line. Implements PRD §9.2 and C-PERF-05 against the
 * real zsh login shell and the real `claude --version` preflight.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { ClaudeSession, ElwoodError } from "../../src/index.ts";
import {
  probeLaunchTimeoutMs,
  resetProbeTimeoutsForTests,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import { shellQuote, userShell } from "../../src/runtime/shell.ts";
import { pathSkipReason, resolvedAgentProgramPath } from "./availability.ts";
import { e2eTimeoutMs, makeProject, skipIf } from "./helpers.ts";

// The profile sleeps twice the command bound. Real `claude --version` answered in at most
// 0.12 s across 16 concurrent runs on a loaded host, so the command bound is ample.
const profileSeconds = 4;
const commandBoundMs = 2_000;

test("C-PERF-05 a real Claude session starts when its login profile outlasts the probe command bound", {
  skip: skipIf(
    // The profile puts the directory of `claude`'s program on PATH, so it needs a program.
    pathSkipReason("claude"),
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
    `sleep ${profileSeconds}\nexport PATH=${shellQuote(dirname(resolvedAgentProgramPath("claude")))}:"$PATH"\n`,
  );
  const previous = process.env["ZDOTDIR"];
  process.env["ZDOTDIR"] = zdotdir;
  setProbeTimeoutsForTests({ commandMs: commandBoundMs, launchMs: probeLaunchTimeoutMs });
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
    resetProbeTimeoutsForTests();
  }
});
