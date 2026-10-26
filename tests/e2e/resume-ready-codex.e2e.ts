/**
 * Real-CLI verification that a RESUMED Codex session reaches readiness promptly
 * on the first composer marker instead of waiting out the ~10s readiness deadline
 * (PRD §5.3, C-API-28). The Codex CLI does not re-fire `SessionStart` on resume, so
 * before this change every resume paid the full deadline; now it is composer-driven.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { sendWithin, waitForCondition } from "./bounded-steps.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";
import { QUIET_DEADLINE_MS, waitForQuietScreen } from "./quiet-screen.ts";

// A private CODEX_HOME holding a copy of the developer's ~/.codex/auth.json and this
// config. Nothing else in the real ~/.codex is read (its default model, effort, MCP
// servers or plugins), and nothing there is written. Its default model's rate limit is
// shared with every Codex session on the account: on 2026-10-25 that model answered 429
// Too Many Requests and Codex backed off for 110-509 s, so the first turn never settled.
// The test needs only a resumable conversation, so it pins a small model at low effort.
const CODEX_CONFIG = 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n';

// Each readiness, turn and submission wait is bounded, and the test timeout covers every
// bound, so a stuck step fails under its own label with the session's screen instead of
// the runner's unlabeled timeout. (Unbounded, `waitFor` would use the suite-wide e2e
// timeout, which equals this test's old 180 s budget.)
const READY_MS = 45_000;
const TURN_MS = 45_000;
const RESUMED_READY_MS = 20_000;
// sendMessage resolves once its submission dispatches, within a second at `ready`.
const SEND_MS = 10_000;

// Twelve measured resumes latched `ready` 0.25 to 0.32 s after the first composer frame.
const COMPOSER_TO_READY_MS = 2_000;
// SessionStart fires at the first prompt, so it has come by the time that turn settles.
const SESSION_START_MS = 10_000;

// The test's steps: the first turn, the observed resume, and the drained ONE and TWO.
const FIRST_TURN_MS = READY_MS + SEND_MS + TURN_MS + SESSION_START_MS;
const DRAINS_MS = RESUMED_READY_MS + 2 * (SEND_MS + TURN_MS);
const STEPS_MS = FIRST_TURN_MS + RESUMED_READY_MS + QUIET_DEADLINE_MS + DRAINS_MS;
// Before it spawns Codex, each of the three launches may run a cold CLI probe. Then two
// stops and up to two teardowns, each at most about 10 s: 5 s graceful and 1 s forced
// termination, a 1 s terminal drain, and Codex's exit.
const LAUNCHES_MS = 3 * (probeLaunchTimeoutMs + probeCommandTimeoutMs);
const TEST_TIMEOUT_MS = STEPS_MS + LAUNCHES_MS + 4 * 10_000;

const ONE = "Reply exactly: ONE. Do not use tools.";
const TWO = "Reply exactly: TWO. Do not use tools.";

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
  const launches = codexLaunches();
  await runCodexTest({ sessions: () => [resumed, first], sandbox, launches }, async () => {
    const session = await launches.track(startCodex(opts));
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
    await waitForCondition(session, () => session.status === "ready", "first turn", TURN_MS);
    await waitForCondition(session, () => sessionStarted, "first SessionStart", SESSION_START_MS);
    const elwoodSessionId = session.elwoodSessionId;
    await session.stop();

    const startedAt = Date.now();
    const resumedSession = await launches.track(resumeCodex({ ...opts, elwoodSessionId }));
    resumed = resumedSession;
    // Capture status transitions from resume start: the transcript replay must NOT
    // fabricate a phantom running->ready cycle after readiness (a host application
    // surfaced that as a false "unread reply").
    const transitions: string[] = [];
    resumedSession.on("status", (event) => transitions.push(event.status));
    // Codex paints nothing for 1.5 to 8 s after the resume spawns it, so readiness is timed
    // from its first composer frame. A composer-driven ready follows within a fraction of
    // a second; the ~10 s fallback deadline starts within a quarter second of the composer,
    // so a deadline-driven ready trails it by about 10 s. A composer already in the replay
    // that subscribing delivers is dated to the resume's start, which can only overstate.
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
    const prompts: string[] = [];
    const draining = await launches.track(
      resumeCodex({
        ...opts,
        elwoodSessionId,
        hooks: {
          UserPromptSubmit: (event) => {
            prompts.push(event.prompt);
          },
          Stop: () => {
            stops += 1;
          },
        },
      }),
    );
    resumed = draining;
    // Queued before ready: the send resolves only once it dispatches.
    await sendWithin(draining, ONE, "ONE", RESUMED_READY_MS + SEND_MS);
    await waitForCondition(draining, () => stops >= 1, "queued ONE drained", TURN_MS);
    await sendWithin(draining, TWO, "TWO", SEND_MS);
    await waitForCondition(draining, () => stops >= 2, "TWO drained", TURN_MS);
    assert.equal(draining.status, "ready", "settled to ready after both turns");
    // Codex accepted each queued message once, in order, and answered each once.
    assert.deepEqual(prompts, [ONE, TWO]);
    assert.equal(stops, 2);
  });
});
