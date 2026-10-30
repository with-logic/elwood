/**
 * Real Codex sessions in two directories, launched through a login shell whose startup files
 * pick `CODEX_HOME` from the directory the shell starts in (`$PWD`). Each session's configured
 * default must come from its own directory's home, never from Elwood's environment or the
 * other session's. Only a session's shell picks one (`inSession`): a probe shell starts in
 * Elwood's own directory and keeps Elwood's home, as the suite's home guard requires
 * (C-E2E-24). Implements PRD §4.2 and C-CODEX-24 (with C-API-23).
 *
 * Every home lives under a scratch project and holds a copy of `auth.json`; the real
 * `~/.codex` and the user's startup files are only read.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { configureCodexDefaultModel, defaultIds, drawnCodexDefault } from "./codex-default.ts";
import {
  baseConfig,
  inSession,
  loginShellSkip,
  loginShellTestTimeoutMs,
  runLoginShellTest,
} from "./codex-login-shell.ts";
import { startReadyCodex } from "./codex-ready.ts";
import { type CodexLaunches, codexLaunches } from "./codex-test-end.ts";
import { type E2eProject, makeProject, sandboxedCodexHome, seedCodexHome } from "./helpers.ts";

const homeName = "codex-home-pwd";

/**
 * Starts one session per project, in project order. Every start settles before this returns
 * or throws, so each started session is in `onStarted`'s list before the test ends.
 */
async function startAll(
  projects: readonly E2eProject[],
  launches: CodexLaunches,
  onStarted: (session: CodexSessionApi) => void,
): Promise<CodexSessionApi[]> {
  const started = await Promise.allSettled(
    projects.map((project) => startReadyCodex(project, { launches, onStarted })),
  );
  return started.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

test("C-CODEX-24 real Codex sessions in two directories each use the home their startup files pick from $PWD", {
  skip: loginShellSkip,
  timeout: loginShellTestTimeoutMs,
}, async () => {
  const projects = [makeProject("codex"), makeProject("codex")] as const;
  const sandbox = sandboxedCodexHome(projects[0], baseConfig); // what Elwood's env names
  const seed = (project: E2eProject) => seedCodexHome(join(project.cwd, homeName), baseConfig);
  const [firstConfigPath, secondConfigPath] = [seed(projects[0]), seed(projects[1])];
  const launches = codexLaunches();
  const held: CodexSessionApi[] = [];
  const scope = { sessions: () => held, sandbox, otherProjects: [projects[1]], launches };
  const exportLine = `${inSession} && export CODEX_HOME="$PWD/${homeName}"`;
  await runLoginShellTest(scope, exportLine, async () => {
    const [first, second] = await startAll(projects, launches, (session) => held.push(session));
    assert.ok(first && second, "both sessions started");
    const unconfigured = await first.listModels();
    const drawn = drawnCodexDefault(unconfigured);
    const [firstModel, secondModel] = unconfigured.filter(
      (model) => !model.isCurrent && model.id !== drawn,
    );
    assert.ok(firstModel && secondModel, "two more models are listed");
    configureCodexDefaultModel(firstConfigPath, firstModel.id);
    configureCodexDefaultModel(secondConfigPath, secondModel.id);
    // Elwood's own environment names the second model, so the first session tells them apart.
    configureCodexDefaultModel(sandbox.configPath, secondModel.id);
    // A drawn marker outranks the config; the markerless layout reports each session's own.
    assert.deepEqual(defaultIds(await first.listModels()), [drawn ?? firstModel.id]);
    assert.deepEqual(defaultIds(await second.listModels()), [drawn ?? secondModel.id]);
  });
});
