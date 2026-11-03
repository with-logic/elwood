/**
 * The e2e home guard against real Claude (PRD §12, C-E2E-24). Startup files that move
 * `CLAUDE_CONFIG_DIR` out of the suite's private homes stop the launch at its version probe,
 * so Claude never runs against, or writes to, another config dir, the user's own included.
 * The start error carries only the guard's fixed reason, and the other dir stays empty. A
 * private `ZDOTDIR` sources the user's own startup files, which are only read.
 */

import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSessionApi, ElwoodError, startClaude } from "../../src/index.ts";
import { homeGuardStoppedReason } from "../../src/runtime/home-guard/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { notZsh, useExportingZdotdir } from "./exporting-zdotdir.ts";
import { cleanup, makeProject, skipIf, skipReason } from "./helpers.ts";

test("C-E2E-24 a Claude e2e whose launch shell's startup files move CLAUDE_CONFIG_DIR never starts Claude", {
  skip: skipIf(skipReason("claude"), notZsh),
  timeout: 60_000,
}, async () => {
  const project = makeProject("claude");
  const elsewhere = join(project.cwd, "elsewhere");
  mkdirSync(elsewhere);
  const restoreZdotdir = useExportingZdotdir(
    project.cwd,
    `export CLAUDE_CONFIG_DIR=${shellQuote(elsewhere)}`,
  );
  let session: ClaudeSessionApi | undefined;
  let failure: unknown;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
  } catch (error) {
    failure = error;
  } finally {
    restoreZdotdir();
    await cleanup(session);
  }
  // A boolean: asserting on the session itself would diff the whole session object, which
  // takes minutes.
  assert.ok(session === undefined, "Claude never started");
  assert.ok(failure instanceof ElwoodError, String(failure));
  assert.equal(failure.code, "claude_start_failed");
  assert.deepEqual(failure.details, {
    stderr: "",
    cause: homeGuardStoppedReason,
    phase: "login_shell",
  });
  assert.deepEqual(readdirSync(elsewhere), [], "nothing wrote to the other config dir");
});
