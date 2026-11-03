/**
 * Real Codex launched through a login shell whose startup files export a DIFFERENT
 * `CODEX_HOME` than Elwood's own environment, and pick it from the launch itself: the session's
 * home only when the shell has a terminal and the session's `ELWOOD_SESSION_ID`, which only the
 * PTY launch has. Elwood must read the configured default from, and restore, the config Codex
 * actually runs with. Implements PRD §4.2 and §5.3, C-CODEX-24 (with C-API-23 and C-CODEX-14).
 *
 * Every home lives under the project and holds a copy of `auth.json`. A private `ZDOTDIR`
 * sources the user's own zsh startup files, so `codex` resolves as usual. The real `~/.codex`
 * and the user's startup files are only read, never written.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
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

type LoginShellHome = {
  /** The config of the home the session's own launch exports: what Codex runs with. */
  readonly sessionConfigPath: string;
  /** The config of the home the same startup files export without a terminal or session. */
  readonly detachedShellConfigPath: string;
  /** The config of the home Elwood's own environment names. */
  readonly elwoodEnvConfigPath: string;
  readonly session: CodexSessionApi;
};

/**
 * Starts Codex under startup files that export the session's home only to the session's own
 * launch, and runs `body` with it. Every home lives under the project, so a test that cannot
 * confirm Codex exited keeps them all.
 */
async function withLoginShellHome(body: (run: LoginShellHome) => Promise<void>): Promise<void> {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, baseConfig); // in process.env
  const sessionHome = join(project.cwd, "codex-home-session");
  const detachedHome = join(project.cwd, "codex-home-detached");
  const sessionConfigPath = seedCodexHome(sessionHome, baseConfig);
  const detachedShellConfigPath = seedCodexHome(detachedHome, baseConfig);
  const exportLine =
    `if ${inSession}; then export CODEX_HOME=${shellQuote(sessionHome)}; ` +
    `else export CODEX_HOME=${shellQuote(detachedHome)}; fi`;
  const launches = codexLaunches();
  const started: CodexSessionApi[] = [];
  await runLoginShellTest({ sessions: () => started, sandbox, launches }, exportLine, async () => {
    const session = await startReadyCodex(project, {
      launches,
      onStarted: (launched) => started.push(launched),
    });
    const elwoodEnvConfigPath = sandbox.configPath;
    await body({ sessionConfigPath, detachedShellConfigPath, elwoodEnvConfigPath, session });
  });
}

test(
  "C-CODEX-24 real Codex reports the configured default from the CODEX_HOME its launch exports",
  {
    skip: loginShellSkip,
    timeout: loginShellTestTimeoutMs,
  },
  () =>
    withLoginShellHome(async (run) => {
      const unconfigured = await run.session.listModels();
      const drawn = drawnCodexDefault(unconfigured);
      const [sessionModel, elsewhereModel] = unconfigured.filter(
        (model) => !model.isCurrent && model.id !== drawn,
      );
      assert.ok(sessionModel && elsewhereModel, "two more models are listed");
      configureCodexDefaultModel(run.sessionConfigPath, sessionModel.id); // what Codex runs with
      configureCodexDefaultModel(run.detachedShellConfigPath, elsewhereModel.id);
      configureCodexDefaultModel(run.elwoodEnvConfigPath, elsewhereModel.id);
      // A drawn marker outranks the config; the markerless layout reports the session's model.
      assert.deepEqual(defaultIds(await run.session.listModels()), [drawn ?? sessionModel.id]);
    }),
);

test(
  "C-CODEX-24 real Codex setModel restores the config.toml its launch exports, and no other",
  {
    skip: loginShellSkip,
    timeout: loginShellTestTimeoutMs,
  },
  () =>
    withLoginShellHome(async (run) => {
      const target = (await run.session.listModels()).find((model) => !model.isCurrent);
      assert.ok(target, "another model is listed");
      const paths = [run.sessionConfigPath, run.detachedShellConfigPath, run.elwoodEnvConfigPath];
      const before = paths.map((path) => readFileSync(path, "utf8"));
      await run.session.setModel(target.id);
      const switched = (await run.session.listModels()).find((model) => model.isCurrent);
      assert.equal(switched?.id, target.id, "the session switched");
      // Codex's picker persisted the selection into the session's home; Elwood restored it there
      // and wrote neither of the others.
      assert.deepEqual(
        paths.map((path) => readFileSync(path, "utf8")),
        before,
      );
    }),
);
