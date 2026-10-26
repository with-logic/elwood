/**
 * `endCodexTest`, and `runCodexTest` that ends a test body through it, remove a Codex test's
 * scratch only once every Codex process that could use it is confirmed gone (PRD §12,
 * C-E2E-03). The real-Codex tests reach only their success path, so the keep paths are
 * pinned here with real scratch directories, a rejected launch, and session doubles. A kept
 * sandbox also hands `CODEX_HOME` back, so the file's later tests do not run in it. No Codex
 * process is started.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test, { after } from "node:test";
import { type CodexTestSession, codexLaunches, endCodexTest, runCodexTest } from "./codex-ready.ts";
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

const stuck: CodexTestSession = {
  teardown: () => Promise.reject(new Error("teardown failed")),
  kill: () => Promise.reject(new Error("kill failed")),
};
const tornDown: CodexTestSession = { teardown: async () => {}, kill: async () => {} };

test("C-E2E-03 a rejected Codex launch keeps its projects and sandbox past the sweep", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const { project, sandbox } = scratch();
  const other = makeProject("codex"); // a second session's workspace
  const launches = codexLaunches();
  await assert.rejects(launches.track(Promise.reject(new Error("spawn failed"))), /spawn failed/);
  assert.equal(launches.rejected, true);
  const end = { sessions: [undefined], projects: [project, other], sandbox, launches };
  await assert.rejects(endCodexTest({ ...end, failure: undefined }), {
    message: `Codex test cleanup failed; kept ${project.cwd}, ${other.cwd}, ${sandbox.home}, which a Codex process may still use`,
  });
  kept.push(project.cwd, other.cwd, sandbox.home);
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome, "the suite's Codex home is back");
  assert.ok([project.cwd, other.cwd, sandbox.home].every(existsSync), "the scratch stays");
});

test("C-E2E-03 a Codex session that cannot be torn down keeps the scratch and reports why", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const { project, sandbox } = scratch();
  let held: CodexTestSession | undefined;
  const scope = { sessions: () => [held], projects: [project], sandbox, launches: codexLaunches() };
  // The session is read once the body ends, so one the body started is torn down too.
  const ended = await runCodexTest(scope, () => {
    held = stuck;
    return Promise.reject(new Error("the test failed"));
  }).catch((error: unknown) => error);
  kept.push(project.cwd, sandbox.home);
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome, "the suite's Codex home is back");
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
  await endCodexTest({
    sessions: [tornDown],
    projects: [project],
    sandbox,
    launches,
    failure: undefined,
  });
  assert.equal(launches.rejected, false);
  assert.equal(existsSync(sandbox.home), false, "the sandbox is gone");
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome);
});
