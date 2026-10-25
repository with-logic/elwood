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
// lifecycle"), so "replay finished" means the rendered screen and window title stayed
// unchanged with no working marker for a SUSTAINED streak of frames — not one quiet
// frame, and not a fixed sleep. Codex 0.164 first paints a "Resuming session…"
// placeholder for up to 1.6 s and only then loads the conversation under a title
// spinner, so neither counts as quiet. Bounded so a never-settling screen still
// reaches the assertion.
const QUIET_STREAK_MS = 2_000;
const QUIET_DEADLINE_MS = 15_000;
const FRAME_MS = 250;
// Twelve measured resumes latched `ready` 0.25 to 0.32 s after Codex's first output.
const COMPOSER_TO_READY_MS = 2_000;

async function waitForQuietScreen(session: CodexSessionApi): Promise<void> {
  const started = Date.now();
  let last = "";
  let quietSince = Date.now();
  while (Date.now() - started < QUIET_DEADLINE_MS) {
    const title = session.terminal.title;
    const text = `${title}\n${session.terminal.snapshot().text}`;
    const unsettled = /esc to interrupt|Resuming session…/i.test(text) || /^[⠀-⣿]/.test(title);
    const quiet = text === last && !unsettled;
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
    const observed = await resumeCodex({ ...opts, elwoodSessionId: id });
    resumed = observed;
    // Capture status transitions from resume start: the transcript replay must NOT
    // fabricate a phantom running->ready cycle after readiness (a host application
    // surfaced that as a false "unread reply").
    const transitions: string[] = [];
    resumed.on("status", (event) => transitions.push(event.status));
    // Codex paints nothing for 1.5 to 8 s after the resume spawns it through the user's
    // login shell, longer on a loaded machine, so readiness is timed from its first
    // composer frame (the screen table's composer rule). A composer-driven ready follows
    // that frame within a fraction of a second. The ~10 s fallback deadline starts at
    // Codex's first rendered frame, which comes within a quarter second of the composer,
    // so a deadline-driven ready would trail the composer by about 10 s.
    let composerAt: number | undefined;
    resumed.on("terminal:data", () => {
      if (composerAt === undefined && /^\s*›/m.test(observed.terminal.snapshot().text))
        composerAt = Date.now();
    });
    await waitFor(() => (resumed?.status === "ready" ? true : undefined), "resumed ready", 30_000);
    const readyAt = Date.now();
    const composer =
      composerAt === undefined
        ? "no composer frame yet"
        : `composer at ${composerAt - startedAt}ms`;
    assert.ok(
      composerAt !== undefined && readyAt - composerAt < COMPOSER_TO_READY_MS,
      `resumed reached ready ${readyAt - startedAt}ms after resume began, ${composer};` +
        ` ready must follow the composer within ${COMPOSER_TO_READY_MS}ms`,
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
