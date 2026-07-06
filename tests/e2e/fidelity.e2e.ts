/**
 * Environment fidelity: project-owned agent configuration loads additively.
 * Implements C-E2E-06 (PRD §4.5).
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, type CodexSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, observeSession, skipReason, waitFor } from "./helpers.ts";

const codexAuthPath = join(homedir(), ".codex", "auth.json");

test("C-E2E-06 project settings hooks and CLAUDE.md load alongside the Elwood bridge", {
  skip: skipReason("claude"),
  timeout: 120_000,
}, async () => {
  const project = makeProject("claude");
  const marker = join(project.cwd, "user-hook-fired");
  const claudeMd = join(project.cwd, "CLAUDE.md");
  writeFileSync(claudeMd, "Project instructions planted by the fidelity e2e test.\n");
  mkdirSync(join(project.cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(project.cwd, ".claude", "settings.json"),
    `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: `/usr/bin/touch ${marker}`, timeout: 10 }],
          },
        ],
      },
    })}\n`,
  );
  let session: ClaudeSession | undefined;
  const instructionPaths: string[] = [];
  let bridgeSessionStarts = 0;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      hooks: {
        SessionStart: () => {
          bridgeSessionStarts += 1;
        },
        InstructionsLoaded: (event) => {
          instructionPaths.push(event.file_path);
        },
      },
    });
    const observed = observeSession(session);
    await waitFor(() => (bridgeSessionStarts > 0 ? true : undefined), "bridge SessionStart hook");
    await waitFor(() => (existsSync(marker) ? true : undefined), "project settings hook marker");
    // Claude reports realpath'd file paths (/private/var vs the /var symlink).
    const claudeMdReal = realpathSync(claudeMd);
    await waitFor(
      () => (instructionPaths.some((path) => path === claudeMdReal) ? true : undefined),
      "InstructionsLoaded for the project CLAUDE.md",
    );
    assert.equal(observed.hookErrors.length, 0);
    // Elwood must not rewrite the project-owned files it found at startup.
    assert.ok(readFileSync(claudeMd, "utf8").includes("planted by the fidelity e2e test"));
    const settingsRaw = readFileSync(join(project.cwd, ".claude", "settings.json"), "utf8");
    assert.ok(settingsRaw.includes("user-hook-fired"));
    assert.ok(
      !settingsRaw.includes("hook-bridge.mjs"),
      "bridge hooks stay out of project settings",
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-06 user Codex config.toml hooks fire alongside the Elwood bridge", {
  skip:
    skipReason("codex") ??
    (existsSync(codexAuthPath) ? undefined : "no ~/.codex/auth.json for a sandboxed CODEX_HOME"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  // A sandboxed CODEX_HOME with the user's real auth reproduces a logged-in
  // machine whose config.toml defines its own hooks, without touching ~/.codex.
  const codexHome = join(project.cwd, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(codexAuthPath, join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  const marker = join(project.cwd, "user-hook-fired");
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      "features = { hooks = true }",
      'hookTrust = "trust-all"',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "startup|resume|clear|compact"',
      `hooks = [{ type = "command", command = "/usr/bin/touch ${marker}", timeout = 5 }]`,
      "",
    ].join("\n"),
  );
  const previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = codexHome;
  let session: CodexSession | undefined;
  let stops = 0;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
      hooks: {
        Stop: () => {
          stops += 1;
        },
      },
    });
    const observed = observeSession(session);
    // Codex dispatches hooks with the first turn, so run one.
    await session.sendMessage("Reply exactly: ELWOOD_FIDELITY_OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "bridge Stop hook");
    await waitFor(() => (existsSync(marker) ? true : undefined), "user config.toml hook marker");
    assert.equal(observed.hookErrors.length, 0);
    // Elwood must not rewrite the user-owned config it merged with.
    const configRaw = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.ok(configRaw.includes("user-hook-fired"));
    assert.ok(!configRaw.includes("hook-bridge.mjs"), "bridge hooks stay out of user config");
    observed.dispose();
  } finally {
    if (previousHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previousHome;
    await cleanup(session);
    rmSync(join(codexHome, "auth.json"), { force: true });
  }
});
