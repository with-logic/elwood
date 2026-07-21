/**
 * Real-CLI verification that a restrictive launch posture PERSISTS across a resume
 * and is not silently loosened (PRD §5.2, §9.3, C-API-29/C-API-32/C-STATE-13). This
 * is the security-relevant behavior the review found contradicted between PRD §5.2
 * and §9.3: the code re-applies the persisted posture, and this pins it to the wire.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, resumeClaude, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

type ClaudeLaunch = {
  readonly permissionMode?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly tools?: readonly string[];
};

function readLaunch(stateDir: string, id: string): ClaudeLaunch | undefined {
  const record = JSON.parse(
    readFileSync(join(stateDir, "sessions", id, "session.json"), "utf8"),
  ) as { claude?: { launch?: ClaudeLaunch } };
  return record.claude?.launch;
}

test("C-API-32 a restrictive Claude posture survives resume unchanged (real CLI)", {
  skip: skipReason("claude"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  let resumed: ClaudeSession | undefined;
  let starts = 0;
  let stops = 0;
  try {
    // Start with a deliberately restrictive posture: a tool allowlist plus a
    // disallow. This is the posture that must NOT loosen across a resume.
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      permissionMode: "default",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      autotrust: true,
      hooks: {
        SessionStart: () => {
          starts += 1;
        },
        Stop: () => {
          stops += 1;
        },
      },
    });
    await waitFor(() => (starts > 0 ? true : undefined), "start SessionStart");
    // Claude only persists a resumable conversation after a turn runs.
    await session.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "first turn Stop");
    const started = readLaunch(project.stateDir, session.elwoodSessionId);
    assert.equal(started?.permissionMode, "default", "posture persisted at start");
    assert.deepEqual([...(started?.tools ?? [])], ["Read", "Grep"], "tool allowlist persisted");
    assert.deepEqual([...(started?.disallowedTools ?? [])], ["Bash"], "disallow persisted");
    await session.stop();
    // Resume with NO explicit posture — the restrictions must default from the
    // persisted record, not fall back to wrapper defaults (which would loosen them).
    resumed = await resumeClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      elwoodSessionId: session.elwoodSessionId,
      autotrust: true,
      hooks: {
        SessionStart: () => {
          starts += 1;
        },
      },
    });
    await waitFor(() => (starts > 1 ? true : undefined), "resumed SessionStart");
    const afterResume = readLaunch(project.stateDir, session.elwoodSessionId);
    assert.equal(afterResume?.permissionMode, "default", "resume kept permissionMode");
    assert.deepEqual(
      [...(afterResume?.tools ?? [])],
      ["Read", "Grep"],
      "resume did not loosen the tool allowlist",
    );
    assert.deepEqual(
      [...(afterResume?.disallowedTools ?? [])],
      ["Bash"],
      "resume did not drop the disallow",
    );
  } finally {
    await cleanup(resumed);
    await cleanup(session);
  }
});
