/**
 * No real-Claude e2e writes the invoking user's Claude config (PRD §12, C-E2E-23). The
 * suite's default `CLAUDE_CONFIG_DIR` (`claude-home.ts`) is private, so the global-config
 * entry Claude writes for a scratch project lands there. The user's own `~/.claude.json`
 * and `~/.claude/projects/` are only read here, never written. Claude sessions outside the
 * suite rewrite `~/.claude.json` all the time, so the check is that nothing in it names the
 * scratch project, not that the file is unchanged. The session runs without the Anthropic
 * credential variables, which log any config dir in on their own, so `ready` proves the
 * copied login. They are unset in Elwood's environment and again in the launch shell after
 * its startup files, which could export one; two cases add startup files that export an
 * invalid one, and a `SessionStart` hook records that Claude got neither. A startup file that moves `CLAUDE_CONFIG_DIR` instead stops the launch before
 * Claude runs (C-E2E-24, `claude-home-guard.e2e.ts`).
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { recordCredentialVariables, recordedVariables } from "./claude-credential-hook.ts";
import {
  defaultClaudeConfigDir,
  defaultClaudeTempDir,
  userConfigDir,
  userGlobalConfig,
} from "./claude-home.ts";
import { anthropicCredentialVariables } from "./claude-login.ts";
import { claudeProjectKeys, projectKeysWithin } from "./claude-projects.ts";
import { claudeTempFolder, claudeTempFoldersNamed } from "./claude-temp.ts";
import { notZsh, useExportingZdotdir } from "./exporting-zdotdir.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";

const credentials = join(defaultClaudeConfigDir, ".credentials.json");
const skip = skipIf(
  skipReason("claude"),
  existsSync(credentials) ? undefined : "the user has no Claude OAuth login to copy",
);
const privateLoginTestTimeoutMs = 240_000;
/** A credential no Anthropic endpoint accepts, so a Claude that got it could not log in. */
const invalidCredential = "elwood-e2e-invalid-credential";

/** The `projects` keys of the Claude global config at `path`, none when it is missing. */
function projectKeys(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config)) throw new Error(`${path} does not hold a JSON object`);
  return claudeProjectKeys(config, path);
}

/**
 * A test named `name` that starts Claude without the credential variables, through startup
 * files that end in `startupLine` when one is given, and checks that it logs in from the
 * private copy, that its environment holds neither variable, and that only the private
 * config names its scratch project.
 */
function privateLoginTest(name: string, skip: string | false, startupLine?: string): void {
  test(name, { skip, timeout: privateLoginTestTimeoutMs }, async () => {
    assert.equal(process.env["CLAUDE_CONFIG_DIR"], defaultClaudeConfigDir);
    const login = readFileSync(credentials, "utf8");
    assert.equal(login.includes("refreshToken"), false, "no refresh token");
    const saved = anthropicCredentialVariables.map((key) => [key, process.env[key]] as const);
    for (const key of anthropicCredentialVariables) delete process.env[key];
    // A startup file can make a credential variable read-only, so `unset` can fail; the
    // launch stops then, rather than run Claude with the credential still set.
    const unset = `unset ${anthropicCredentialVariables.join(" ")} || exit 1`;
    setPtyFactoryForTests((options) =>
      nodePtyFactory({ ...options, args: prefixShellArgument(options.args, unset) }),
    );
    const project = makeProject("claude");
    const record = recordCredentialVariables(project.cwd);
    const restoreZdotdir =
      startupLine === undefined ? undefined : useExportingZdotdir(project.cwd, startupLine);
    let session: ClaudeSessionApi | undefined;
    try {
      session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      const started = session;
      await waitFor(
        () => (started.status === "ready" ? true : undefined),
        "Claude reaches ready, logged in from the private copy",
        120_000,
      );
      const seen = await waitFor(
        () => recordedVariables(record),
        "Claude's SessionStart hook records its credential variables",
        30_000,
      );
      assert.deepEqual(seen, [], "Claude's environment holds no Anthropic credential variable");
    } finally {
      await cleanup(session);
      restoreZdotdir?.();
      resetRuntimeSeamsForTests();
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    }
    const cwd = realpathSync(project.cwd);
    const recorded = projectKeys(join(defaultClaudeConfigDir, ".claude.json"));
    assert.ok(recorded.includes(cwd), `Claude recorded ${cwd} in the private config`);
    assert.deepEqual(
      projectKeysWithin(projectKeys(userGlobalConfig), [cwd, project.cwd]),
      [],
      "the user's global config never names the scratch project",
    );
    const transcripts = join(userConfigDir, "projects");
    const folders = existsSync(transcripts) ? readdirSync(transcripts) : [];
    const folderName = basename(project.cwd).replaceAll("_", "-");
    assert.deepEqual(
      folders.filter((folder) => folder.includes(folderName)),
      [],
      "the user's transcript folders never include the scratch project",
    );
    const tempFolder = claudeTempFolder(cwd);
    assert.deepEqual(
      claudeTempFoldersNamed(defaultClaudeTempDir, tempFolder),
      [tempFolder],
      "Claude keeps the scratch project's temp folder under the private temp root",
    );
    assert.deepEqual(
      claudeTempFoldersNamed("/tmp", tempFolder),
      [],
      "and never under the shared /tmp",
    );
  });
}

privateLoginTest(
  "C-E2E-23 a Claude e2e logs in from its private copy and never names its scratch project in the user's config or transcripts",
  skip,
);

for (const variable of anthropicCredentialVariables)
  privateLoginTest(
    `C-E2E-23 a Claude e2e logs in from its private copy when its launch shell's startup files export ${variable}`,
    skipIf(skip, notZsh),
    `export ${variable}=${invalidCredential}`,
  );
