/**
 * The compiled-CLI e2e scratch removes a Codex test's project and sandbox only once every
 * `elwood` run it made confirmed its own cleanup by exiting 0 (PRD §12A, C-CLI-23 through
 * C-CLI-26). The real-CLI tests reach only their success path, so the keep path is pinned
 * here with real scratch directories and real `elwood` runs that start no agent.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { cleanedUp, cliScratch } from "./cli-commands-scratch.ts";
import { codexAuthMissing, makeProject, sandboxedCodexHome, skipIf } from "./helpers.ts";

const suiteCodexHome = process.env["CODEX_HOME"];
const kept: string[] = [];

// Registered after the scratch sweep's hook, so it runs after the sweep: kept scratch must
// have survived it.
after(() => {
  const swept = kept.filter((root) => !existsSync(root));
  for (const root of kept) rmSync(root, { recursive: true, force: true });
  if (swept.length > 0) throw new Error(`the scratch sweep removed kept ${swept.join(", ")}`);
});

test("C-CLI-26 a CLI run confirms its cleanup only by exiting 0", () => {
  const confirmed = { status: 0, stdout: "{}", stderr: "" };
  assert.equal(cleanedUp(confirmed), confirmed);
  for (const status of [1, 2, 124, null])
    assert.throws(
      () => cleanedUp({ status, stdout: "out", stderr: "err" }),
      new RegExp(`exited ${status} without confirming its cleanup\\nstdout: out\\nstderr: err`),
    );
});

test("C-CLI-26 a Codex test keeps its project and sandbox after a run that exits nonzero", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "");
  kept.push(project.cwd, sandbox.home);
  const scratch = cliScratch(project, sandbox);
  // A usage error exits 2 before any agent starts; it must still not count as confirmed.
  const rejected = scratch.end(async () => {
    await scratch.run(["--no-such-flag"], tmpdir()).catch(() => undefined);
  });
  await assert.rejects(rejected, /kept .*which a Codex process may still use/);
  assert.ok(existsSync(project.cwd) && existsSync(sandbox.home));
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome);
});

test("C-CLI-26 a Codex test whose runs all exit 0 removes its sandbox", {
  skip: skipIf(codexAuthMissing()),
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "");
  const scratch = cliScratch(project, sandbox);
  await scratch.end(async () => {
    const listed = await scratch.run(["sessions", `--state-dir=${project.stateDir}`], tmpdir());
    assert.equal(listed.status, 0, listed.stderr);
  });
  assert.equal(existsSync(sandbox.home), false);
  assert.equal(process.env["CODEX_HOME"], suiteCodexHome);
});

test("C-CLI-26 a Claude test's runs are not Codex launches, and its project goes", async () => {
  const project = makeProject("claude");
  const scratch = cliScratch(project, undefined);
  await scratch.end(async () => {
    assert.equal((await scratch.run(["--no-such-flag"], tmpdir())).status, 2);
  });
  assert.equal(existsSync(project.cwd), false);
});
