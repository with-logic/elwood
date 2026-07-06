/**
 * Environment fidelity: project-owned agent configuration loads additively.
 * Implements C-E2E-06 (PRD §4.5).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { type ClaudeSession, startClaude } from "../../src/index.ts";
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

// Codex TUI hook merging cannot be sandbox-tested on codex-cli 0.142: setting
// CODEX_HOME at all silently disables TUI hook execution (see PRD §5.7,
// codex_home_hooks_disabled). The additive user-hook contract is verified
// against the real binary through codex exec, which honors the same config.
test("C-E2E-06 codex exec merges user config.toml hooks with session -c hooks", {
  skip:
    skipReason("codex") ??
    (existsSync(codexAuthPath) ? undefined : "no ~/.codex/auth.json for a sandboxed CODEX_HOME"),
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  const codexHome = join(project.cwd, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(codexAuthPath, join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  const userMarker = join(project.cwd, "user-hook-fired");
  const sessionMarker = join(project.cwd, "session-hook-fired");
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      "features = { hooks = true }",
      'hookTrust = "trust-all"',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "startup|resume|clear|compact"',
      `hooks = [{ type = "command", command = "/usr/bin/touch ${userMarker}", timeout = 5 }]`,
      "",
    ].join("\n"),
  );
  const override = `hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command="/usr/bin/touch ${sessionMarker}",timeout=5}]}]`;
  const command = [
    `CODEX_HOME='${codexHome}'`,
    "codex exec",
    `--cd '${project.cwd}'`,
    "--skip-git-repo-check",
    "-s read-only",
    "--dangerously-bypass-hook-trust",
    `-c '${override.replaceAll("'", "'\\''")}'`,
    "'Reply exactly: OK'",
  ].join(" ");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/zsh", ["-l", "-i", "-c", command], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}`)),
      );
    });
    await waitFor(
      () => (existsSync(userMarker) ? true : undefined),
      "user config.toml hook",
      15_000,
    );
    await waitFor(
      () => (existsSync(sessionMarker) ? true : undefined),
      "session-scoped -c hook",
      15_000,
    );
    const configRaw = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.ok(configRaw.includes("user-hook-fired"), "user config left intact");
  } finally {
    rmSync(join(codexHome, "auth.json"), { force: true });
  }
});
