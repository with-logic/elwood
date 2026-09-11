/**
 * Real-CLI verification that a RESUMED Codex session reaches readiness promptly
 * on the first composer marker instead of waiting out the ~10s readiness deadline
 * (PRD §5.3, C-API-28). The Codex CLI does not re-fire `SessionStart` on resume, so
 * before this change every resume paid the full deadline; now it is composer-driven.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

// The resumed transcript replay repaints in bursts (docs/cli-behavior.md, "Resume
// lifecycle"), so "replay finished" means the rendered screen stayed unchanged with no
// working marker for a SUSTAINED streak of frames — not one quiet frame, and not a
// fixed sleep. Bounded so a never-settling screen still reaches the assertion.
const QUIET_STREAK_MS = 2_000;
const QUIET_DEADLINE_MS = 15_000;
const FRAME_MS = 250;

async function waitForQuietScreen(session: CodexSessionApi): Promise<void> {
  const started = Date.now();
  let last = "";
  let quietSince = Date.now();
  while (Date.now() - started < QUIET_DEADLINE_MS) {
    const text = session.terminal.snapshot().text;
    const quiet = text === last && !/esc to interrupt/i.test(text);
    if (!quiet) quietSince = Date.now();
    if (Date.now() - quietSince >= QUIET_STREAK_MS) return;
    last = text;
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }
}

test("C-API-28 real Codex resume reaches ready promptly (composer, not the 10s deadline)", {
  skip: skipIf(skipReason("codex"), skipTurns),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  const opts = {
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    autotrust: true,
    hooks: {},
  };
  let first: CodexSessionApi | undefined;
  let resumed: CodexSessionApi | undefined;
  try {
    first = await startCodex(opts);
    await waitFor(() => (first?.status === "ready" ? true : undefined), "first ready", 60_000);
    // One real turn so Codex persists a resumable conversation id.
    await first.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(
      () => (first?.status === "ready" ? true : undefined),
      "first turn settled",
      60_000,
    );
    const id = first.elwoodSessionId;
    await first.stop();

    const startedAt = Date.now();
    resumed = await resumeCodex({ ...opts, elwoodSessionId: id });
    // Capture status transitions from resume start: the transcript replay must NOT
    // fabricate a phantom running->ready cycle after readiness (a host application
    // surfaced that as a false "unread reply").
    const transitions: string[] = [];
    resumed.on("status", (event) => transitions.push(event.status));
    await waitFor(() => (resumed?.status === "ready" ? true : undefined), "resumed ready", 30_000);
    const elapsed = Date.now() - startedAt;
    // The 10s deadline was the old floor; the composer path reaches ready well under
    // it. Allow generous headroom for CI while still proving we don't pay the deadline.
    assert.ok(
      elapsed < 8_000,
      `resumed reached ready in ${elapsed}ms (must beat the ~10s deadline)`,
    );
    // Wait for the transcript replay to finish painting (a sustained quiet screen),
    // then assert no phantom turn fired: once ready, the settling watcher swallows
    // replayed working-token flashes, so no spurious `running` transition appears
    // after readiness (no false unread).
    await waitForQuietScreen(resumed);
    const afterReady = transitions.slice(transitions.indexOf("ready") + 1);
    assert.deepEqual(
      afterReady,
      [],
      `no status transition may follow resume readiness, saw: ${afterReady.join(",")}`,
    );

    // STOP (not teardown) the observe-only resume: teardown removes the session dir,
    // which the drain resume below needs. stop() leaves the resumable state intact.
    await resumed.stop();
    resumed = undefined;

    // A message queued while still resuming (before ready) must DRAIN once ready — and
    // a SECOND message must drain after it, proving the queue is live post-resume and
    // the turn-state watcher tracks real turns without relying on a Stop hook.
    let stops = 0;
    resumed = await resumeCodex({
      ...opts,
      elwoodSessionId: id,
      hooks: {
        Stop: () => {
          stops += 1;
        },
      },
    });
    await resumed.sendMessage("Reply exactly: ONE. Do not use tools."); // queued pre-ready
    await waitFor(() => (stops >= 1 ? true : undefined), "queued-before-ready message drained");
    await resumed.sendMessage("Reply exactly: TWO. Do not use tools."); // a second, post-ready
    await waitFor(() => (stops >= 2 ? true : undefined), "second message drained");
    assert.equal(resumed.status, "ready", "settled to ready after both turns");
  } finally {
    await cleanup(resumed);
    await cleanup(first);
  }
});
