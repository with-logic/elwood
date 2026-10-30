/**
 * Real Codex started from a symlinked directory, through a login shell whose startup files
 * export a RELATIVE `CODEX_HOME` with `..` in it, in a session's shell only (`inSession`). The
 * kernel follows the link before `..`, so Codex runs with the home beside the link's target, not
 * the one the link's name suggests. Elwood must read the configured default from, and restore,
 * that home. A probe shell starts in Elwood's own directory and keeps Elwood's home, as the
 * suite's home guard requires (C-E2E-24). Implements PRD §4.2 and C-CODEX-24 (with C-API-23
 * and C-CODEX-14).
 *
 * Every home lives under the project and holds a copy of `auth.json`. A private `ZDOTDIR`
 * sources the user's own zsh startup files, so `codex` resolves as usual. The real `~/.codex`
 * and the user's startup files are only read, never written.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
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
import { codexLaunches } from "./codex-test-end.ts";
import { makeProject, sandboxedCodexHome, seedCodexHome } from "./helpers.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("C-CODEX-24 real Codex in a symlinked cwd runs with, and Elwood restores, the relative CODEX_HOME beside the link's target", {
  skip: loginShellSkip,
  timeout: loginShellTestTimeoutMs,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, baseConfig); // what Elwood's env names
  const worktree = join(project.cwd, "worktrees", "feature");
  mkdirSync(worktree, { recursive: true });
  const link = join(project.cwd, "feature-link");
  symlinkSync(worktree, link);
  // `../codex-home` from the worktree, where Codex runs, and from the link's name.
  const physicalConfig = seedCodexHome(join(project.cwd, "worktrees", "codex-home"), baseConfig);
  const byNameConfig = seedCodexHome(join(project.cwd, "codex-home"), baseConfig);
  const launches = codexLaunches();
  const started: CodexSessionApi[] = [];
  const scope = { sessions: () => started, sandbox, launches };
  const exportLine = `${inSession} && export CODEX_HOME=../codex-home`;
  await runLoginShellTest(scope, exportLine, async () => {
    const session = await startReadyCodex(
      { ...project, cwd: link },
      { launches, onStarted: (launched) => started.push(launched) },
    );
    const unconfigured = await session.listModels();
    const drawn = drawnCodexDefault(unconfigured);
    const [physicalModel, elsewhereModel] = unconfigured.filter(
      (model) => !model.isCurrent && model.id !== drawn,
    );
    assert.ok(physicalModel && elsewhereModel, "two more models are listed");
    configureCodexDefaultModel(physicalConfig, physicalModel.id);
    configureCodexDefaultModel(byNameConfig, elsewhereModel.id);
    configureCodexDefaultModel(sandbox.configPath, elsewhereModel.id);
    // A drawn marker outranks the config; the markerless layout reports the physical home's.
    assert.deepEqual(defaultIds(await session.listModels()), [drawn ?? physicalModel.id]);
    const paths = [physicalConfig, byNameConfig, sandbox.configPath];
    const before = paths.map(read);
    await session.setModel(elsewhereModel.id);
    // Codex's picker persisted the selection into the home it runs with; Elwood restored it
    // there and wrote neither of the others.
    assert.deepEqual(paths.map(read), before);
  });
});
