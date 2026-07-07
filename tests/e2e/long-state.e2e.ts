/**
 * Real-agent sessions with deeply nested caller stateDir layouts.
 * Implements C-STATE-12 (PRD §8.1) — the Coal Harbor blocking repro.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { type ClaudeSession, resumeClaude, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

test("C-STATE-12 real Claude starts and resumes from a 200-char stateDir", {
  skip: skipReason("claude"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  const stateDir = join(
    project.cwd,
    "workspaces/w".repeat(6),
    "features/f".repeat(6),
    "sessions",
    "elwood",
  );
  assert.ok(stateDir.length >= 180, `repro stateDir is long enough (${stateDir.length})`);
  let session: ClaudeSession | undefined;
  let resumed: ClaudeSession | undefined;
  let sessionStarts = 0;
  try {
    let stops = 0;
    session = await startClaude({
      cwd: project.cwd,
      stateDir,
      // C-CLAUDE-13: the real CLI accepts the --tools allowlist.
      tools: ["Read", "Glob", "Grep"],
      autotrust: true,
      permissionMode: "bypassPermissions",
      hooks: {
        SessionStart: () => {
          sessionStarts += 1;
        },
        Stop: () => {
          stops += 1;
        },
      },
    });
    await waitFor(() => (sessionStarts > 0 ? true : undefined), "bridge SessionStart hook");
    // Claude only persists a resumable conversation once a turn has run.
    await session.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "first turn Stop hook");
    const record = JSON.parse(
      readFileSync(join(stateDir, "sessions", session.elwoodSessionId, "session.json"), "utf8"),
    ) as { paths: { socketPath: string } };
    assert.ok(record.paths.socketPath.length < 104, "socket path clears the sun_path cap");
    await session.stop();
    resumed = await resumeClaude({
      cwd: project.cwd,
      stateDir,
      elwoodSessionId: session.elwoodSessionId,
      autotrust: true,
      // C-API-29: privilege options are accepted in real resume position.
      permissionMode: "bypassPermissions",
      tools: ["Read", "Glob", "Grep"],
      hooks: {
        SessionStart: () => {
          sessionStarts += 1;
        },
      },
    });
    await waitFor(() => (sessionStarts > 1 ? true : undefined), "resumed SessionStart hook");
    const resumedRecord = JSON.parse(
      readFileSync(join(stateDir, "sessions", session.elwoodSessionId, "session.json"), "utf8"),
    ) as { paths: { socketPath: string } };
    const socketHome = dirname(resumedRecord.paths.socketPath);
    await resumed.teardown();
    assert.equal(existsSync(socketHome), false, "teardown removes the socket home");
  } finally {
    await cleanup(resumed);
    await cleanup(session);
  }
});
