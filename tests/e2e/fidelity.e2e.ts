/**
 * Environment fidelity: project-owned agent configuration loads additively.
 * Implements C-E2E-06 (PRD §4.5).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, observeSession, skipReason, waitFor } from "./helpers.ts";

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
