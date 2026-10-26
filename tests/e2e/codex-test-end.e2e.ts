/**
 * `endCodexTest` removes a Codex test's scratch only once every Codex process that could use
 * it is confirmed gone (PRD §12, C-E2E-03). The real-Codex tests reach only its success
 * path, so its keep paths are pinned here with real scratch directories, a rejected launch,
 * and session doubles. No Codex process is started.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test, { after } from "node:test";
import { type CodexTestSession, codexLaunches, endCodexTest } from "./codex-ready.ts";
import { codexAuthMissing, makeProject, sandboxedCodexHome, skipIf } from "./helpers.ts";

const suiteCodexHome = process.env["CODEX_HOME"];
const kept: string[] = [];

// The scratch sweep registered its hook when this file imported it, so this one runs after
// the sweep: scratch that cleanup kept must have survived it.
after(() => {
  const swept = kept.filter((root) => !existsSync(root));
  for (const root of kept) rmSync(root, { recursive: true, force: true });
  if (swept.length > 0) throw new Error(`the scratch sweep removed kept ${swept.join(", ")}`);
});

function scratch() {
  const project = makeProject("codex");
  return { project, sandbox: sandboxedCodexHome(project, "") };
}

/** The sandbox was not disposed, so `CODEX_HOME` still names it: restore the suite's. */
function restoreSuiteHome(): void {
  if (suiteCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = suiteCodexHome;
}

const stuck: CodexTestSession = {
  teardown: () => Promise.reject(new Error("teardown failed")),
  kill: () => Promise.reject(new Error("kill failed")),
};
const tornDown: CodexTestSession = { teardown: async () => {}, kill: async () => {} };

test("C-E2E-03 a rejected Codex launch keeps the project and sandbox past the sweep", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const { project, sandbox } = scratch();
  const launches = codexLaunches();
  await assert.rejects(launches.track(Promise.reject(new Error("spawn failed"))), /spawn failed/);
  assert.equal(launches.rejected, true);
  await assert.rejects(
    endCodexTest({ sessions: [undefined], project, sandbox, launches, failure: undefined }),
    {
      message: `Codex test cleanup failed; kept ${project.cwd} and ${sandbox.home}, which a Codex process may still use`,
    },
  );
  kept.push(project.cwd, sandbox.home);
  restoreSuiteHome();
  assert.ok(existsSync(project.cwd) && existsSync(sandbox.home), "the scratch stays");
});

test("C-E2E-03 a Codex session that cannot be torn down keeps the scratch and reports why", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const { project, sandbox } = scratch();
  const failure = new Error("the test failed");
  const ended = await endCodexTest({
    sessions: [stuck],
    project,
    sandbox,
    launches: codexLaunches(),
    failure,
  }).catch((error: unknown) => error);
  kept.push(project.cwd, sandbox.home);
  restoreSuiteHome();
  assert.ok(ended instanceof AggregateError, "cleanup fails the test");
  assert.deepEqual(
    ended.errors.map((error: unknown) => (error instanceof Error ? error.message : error)),
    ["the test failed", "teardown failed", "kill failed"],
  );
  assert.ok(existsSync(project.cwd) && existsSync(sandbox.home), "the scratch stays");
});

test("C-E2E-03 confirmed teardown removes the sandbox and restores the suite's Codex home", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const { project, sandbox } = scratch();
  const launches = codexLaunches();
  await launches.track(Promise.resolve());
  await endCodexTest({ sessions: [tornDown], project, sandbox, launches, failure: undefined });
  assert.equal(launches.rejected, false);
  assert.equal(existsSync(sandbox.home), false, "the sandbox is gone");
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome);
});
