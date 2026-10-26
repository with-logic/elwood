/**
 * No real-Claude e2e writes the invoking user's Claude config (PRD §12, C-E2E-23). The
 * suite's default `CLAUDE_CONFIG_DIR` (`claude-home.ts`) is private, so the global-config
 * entry Claude writes for a scratch project lands there. The user's own `~/.claude.json`
 * and `~/.claude/projects/` are only read here, never written. Claude sessions outside the
 * suite rewrite `~/.claude.json` all the time, so the check is that nothing in it names the
 * scratch project, not that the file is unchanged.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { defaultClaudeConfigDir, userConfigDir, userGlobalConfig } from "./claude-home.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";

/** The `projects` keys of the Claude global config at `path`. */
function projectKeys(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, "utf8")) as { projects?: object };
  return Object.keys(config.projects ?? {});
}

test("C-E2E-23 a Claude e2e leaves the user's Claude config untouched", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  assert.equal(process.env["CLAUDE_CONFIG_DIR"], defaultClaudeConfigDir);
  const credentials = join(defaultClaudeConfigDir, ".credentials.json");
  if (existsSync(credentials)) {
    const login = JSON.parse(readFileSync(credentials, "utf8")) as object;
    assert.equal(JSON.stringify(login).includes("refreshToken"), false, "no refresh token");
  }
  const project = makeProject("claude");
  const name = basename(project.cwd);
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const started = session;
    await waitFor(
      () => (started.status === "ready" ? true : undefined),
      "Claude reaches ready, logged in, with the private config dir",
      120_000,
    );
  } finally {
    await cleanup(session);
  }
  const cwd = realpathSync(project.cwd);
  const recorded = projectKeys(join(defaultClaudeConfigDir, ".claude.json"));
  assert.ok(recorded.includes(cwd), `Claude recorded ${cwd} in the private config`);
  assert.deepEqual(
    projectKeys(userGlobalConfig).filter((key) => key.includes(name)),
    [],
    "the user's global config never names the scratch project",
  );
  const transcripts = join(userConfigDir, "projects");
  const folders = existsSync(transcripts) ? readdirSync(transcripts) : [];
  assert.deepEqual(
    folders.filter((folder) => folder.includes(name.replaceAll("_", "-"))),
    [],
    "the user's transcript folders never include the scratch project",
  );
});
