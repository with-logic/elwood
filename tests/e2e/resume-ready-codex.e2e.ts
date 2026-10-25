/**
 * Real-CLI verification that a RESUMED Codex session reaches readiness promptly
 * on the first composer marker instead of waiting out the ~10s readiness deadline
 * (PRD §5.3, C-API-28). The Codex CLI does not re-fire `SessionStart` on resume, so
 * before this change every resume paid the full deadline; now it is composer-driven.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { sendWithin, waitForCondition } from "./bounded-steps.ts";
import { stopCodex } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";
import { waitForQuietScreen } from "./quiet-screen.ts";

// A private CODEX_HOME holding a copy of the developer's ~/.codex/auth.json and this
// config. Nothing else in the real ~/.codex is read (its default model, effort, MCP
// servers or plugins), and nothing there is written. Its default model's rate limit is shared with every Codex session on the
// account: on 2026-10-25 that model answered 429 Too Many Requests and Codex backed
// off for 110-509 s, so the first turn never settled. The test needs only a
// resumable conversation, so it pins a small model at low effort.
const CODEX_CONFIG = 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n';

// Each readiness, turn and submission wait is bounded, and the bounds sum to less than
// the test timeout, so a stuck step fails under its own label with the session's
// screen instead of the runner's unlabeled timeout. (Unbounded, `waitFor` would use
// the suite-wide e2e timeout, which equals this test's old 180 s budget.)
const TEST_TIMEOUT_MS = 300_000;
const READY_MS = 45_000;
const TURN_MS = 45_000;
const RESUMED_READY_MS = 20_000;
// sendMessage resolves once its submission dispatches, within a second at `ready`.
const SEND_MS = 10_000;

// Twelve measured resumes latched `ready` 0.25 to 0.32 s after the first composer frame.
const COMPOSER_TO_READY_MS = 2_000;
// SessionStart fires at the first prompt, so it has come by the time that turn settles.
const SESSION_START_MS = 10_000;

test("C-API-28 real Codex resume reaches ready promptly (composer, not the 10s deadline)", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
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
  let failure: unknown;
  try {
    const session = await startCodex(opts);
    first = session;
    // Codex fires `SessionStart` lazily, at the first prompt, and it alone carries the
    // conversation id a resume needs.
    let sessionStarted = false;
    session.on("hook", (event) => {
      if (event.hook_event_name === "SessionStart") sessionStarted = true;
    });
    await waitForCondition(session, () => session.status === "ready", "first ready", READY_MS);
    // One real turn so Codex persists a resumable conversation id. sendMessage
    // resolves after its submission moved the session to running, so this wait
    // cannot pass on the pre-send ready.
    await sendWithin(session, "Reply exactly: OK. Do not use tools.", "the first turn", SEND_MS);
    await waitForCondition(
      session,
      () => session.status === "ready",
      "first turn settled",
      TURN_MS,
    );
    await waitForCondition(session, () => sessionStarted, "first SessionStart", SESSION_START_MS);
    const id = session.elwoodSessionId;
    await session.stop();

    const startedAt = Date.now();
    const resumedSession = await resumeCodex({ ...opts, elwoodSessionId: id });
    resumed = resumedSession;
    // Capture status transitions from resume start: the transcript replay must NOT
    // fabricate a phantom running->ready cycle after readiness (a host application
    // surfaced that as a false "unread reply").
    const transitions: string[] = [];
    resumedSession.on("status", (event) => transitions.push(event.status));
    // Codex paints nothing for 1.5 to 8 s after the resume spawns it through the user's
    // login shell, longer on a loaded machine, so readiness is timed from its first
    // composer frame (the screen table's composer rule). A composer-driven ready follows
    // that frame within a fraction of a second. The ~10 s fallback deadline starts at
    // Codex's first rendered frame, which comes within a quarter second of the composer,
    // so a deadline-driven ready would trail the composer by about 10 s. Subscribing
    // replays output rendered before it; a composer already in that replay is dated to
    // the resume's start, the earliest it could have painted, which can only overstate
    // the latency.
    let composerAt: number | undefined;
    let replaying = true;
    resumedSession.on("terminal:data", () => {
      if (composerAt === undefined && /^\s*›/m.test(resumedSession.terminal.snapshot().text))
        composerAt = replaying ? startedAt : Date.now();
    });
    replaying = false;
    await waitForCondition(
      resumedSession,
      () => resumedSession.status === "ready",
      "resumed ready",
      RESUMED_READY_MS,
    );
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
    const draining = await resumeCodex({
      ...opts,
      elwoodSessionId: id,
      hooks: {
        Stop: () => {
          stops += 1;
        },
      },
    });
    resumed = draining;
    // Queued before ready: the send resolves only once it dispatches.
    await sendWithin(
      draining,
      "Reply exactly: ONE. Do not use tools.",
      "ONE",
      RESUMED_READY_MS + SEND_MS,
    );
    await waitForCondition(
      draining,
      () => stops >= 1,
      "queued-before-ready message drained",
      TURN_MS,
    );
    await sendWithin(draining, "Reply exactly: TWO. Do not use tools.", "TWO", SEND_MS);
    await waitForCondition(draining, () => stops >= 2, "second message drained", TURN_MS);
    assert.equal(draining.status, "ready", "settled to ready after both turns");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // The auth copy goes only once every Codex process that could use it is confirmed
    // gone. Otherwise it stays for the file's scratch sweep, and the test fails with
    // both the shutdown failures and any earlier failure.
    const shutdownFailures: unknown[] = [];
    for (const session of [resumed, first]) {
      if (session) shutdownFailures.push(...(await stopCodex(session)));
    }
    if (shutdownFailures.length === 0) sandbox.dispose();
    else {
      const errors = failure === undefined ? shutdownFailures : [failure, ...shutdownFailures];
      // biome-ignore lint/correctness/noUnsafeFinally: a process that outlives the test must fail it.
      throw new AggregateError(errors, "Codex sessions did not shut down");
    }
  }
});
