/**
 * Real-agent sessions with deeply nested caller stateDir layouts.
 * Implements C-STATE-12 (PRD §8.1) — the Coal Harbor blocking repro.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, resumeClaude, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

/** The per-launch socket homes Elwood minted (fresh mkdtemp `elwood-*` under tmpdir). */
function socketHomes(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("elwood-"))
      .map((name) => join(tmpdir(), name)),
  );
}

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
  const homesBefore = socketHomes();
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
    // The socket home is minted fresh under tmpdir (not under the 200-char stateDir),
    // so its path clears the macOS sun_path cap even with a deeply nested stateDir.
    const startedHome = [...socketHomes()].find((h) => !homesBefore.has(h));
    assert.ok(startedHome, "start minted a fresh elwood- socket home under tmpdir");
    assert.ok(join(startedHome, "h.sock").length < 104, "socket path clears the sun_path cap");
    await session.stop();
    resumed = await resumeClaude({
      cwd: project.cwd,
      stateDir,
      elwoodSessionId: session.elwoodSessionId,
      autotrust: true,
      // C-API-32 C-STATE-13: no explicit posture — the resumed launch derives
      // entirely from the record persisted at start, against the real CLI.
      hooks: {
        SessionStart: () => {
          sessionStarts += 1;
        },
      },
    });
    await waitFor(() => (sessionStarts > 1 ? true : undefined), "resumed SessionStart hook");
    // Resume mints ANOTHER fresh socket home; teardown must remove it.
    const resumedHome = [...socketHomes()].find((h) => !homesBefore.has(h) && h !== startedHome);
    assert.ok(resumedHome, "resume minted a fresh socket home");
    await resumed.teardown();
    assert.equal(existsSync(resumedHome), false, "teardown removes the socket home");
  } finally {
    await cleanup(resumed);
    await cleanup(session);
  }
});
