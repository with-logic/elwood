/**
 * No real-Claude e2e writes the invoking user's Claude config (PRD §12, C-E2E-23). The
 * suite's default `CLAUDE_CONFIG_DIR` (`claude-home.ts`) is private, so the global-config
 * entry Claude writes for a scratch project lands there. The user's own `~/.claude.json`
 * and `~/.claude/projects/` are only read here, never written. Claude sessions outside the
 * suite rewrite `~/.claude.json` all the time, so the check is that nothing in it names the
 * scratch project, not that the file is unchanged. The session runs without the API-key
 * variables, which log any config dir in on their own, so `ready` proves the copied login.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { defaultClaudeConfigDir, userConfigDir, userGlobalConfig } from "./claude-home.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";

const credentials = join(defaultClaudeConfigDir, ".credentials.json");
const apiKeyVariables = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The `projects` keys of the Claude global config at `path`. */
function projectKeys(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config)) throw new Error(`${path} does not hold a JSON object`);
  const projects = config["projects"];
  return isRecord(projects) ? Object.keys(projects) : [];
}

test("C-E2E-23 a Claude e2e logs in from its private copy and never names its scratch project in the user's config or transcripts", {
  skip: skipIf(
    skipReason("claude"),
    existsSync(credentials) ? undefined : "the user has no Claude OAuth login to copy",
  ),
  timeout: 240_000,
}, async () => {
  assert.equal(process.env["CLAUDE_CONFIG_DIR"], defaultClaudeConfigDir);
  const login = readFileSync(credentials, "utf8");
  assert.equal(login.includes("refreshToken"), false, "no refresh token");
  const saved = apiKeyVariables.map((name) => [name, process.env[name]] as const);
  for (const name of apiKeyVariables) delete process.env[name];
  const project = makeProject("claude");
  const name = basename(project.cwd);
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const started = session;
    await waitFor(
      () => (started.status === "ready" ? true : undefined),
      "Claude reaches ready, logged in from the private copy",
      120_000,
    );
  } finally {
    await cleanup(session);
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
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
