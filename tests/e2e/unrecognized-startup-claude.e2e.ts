/**
 * A real Claude first launch opens on screens Elwood does not recognize. From the readiness
 * deadline the session is `blocked` on them with their text, the host answers them with
 * raw keys, and a message queued at start is then submitted onto the verified composer.
 * Implements C-E2E-28 (PRD §5.4, C-ATTN-09).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { answerFirstLaunch, firstLaunch } from "./claude-first-launch.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { recordPty } from "./pty-record.ts";
import { awaitStartupBlock } from "./unrecognized-startup.ts";

test("C-E2E-28 Claude's first-launch screens block the session, and raw keys answer them", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  const launch = firstLaunch();
  const record = recordPty();
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      env: launch.env,
    });
    const active = session;
    const sent = active.sendMessage("Reply with the single word PONG and nothing else.");
    const { observed } = await awaitStartupBlock(active, record, sent, {
      label: "claude-unrecognized-startup",
      screen: "Choose the text style",
    });

    const reports = () =>
      observed.activities.filter((event) => event.kind === "unrecognized_startup");
    assert.equal(reports().length, 1, "the picker was reported once");
    const pressed = await answerFirstLaunch(active);
    assert.deepEqual(
      pressed.slice(0, 2),
      ["\r", "\r"],
      "the picker and the security notes were answered",
    );
    await sent;
    await waitFor(
      () =>
        observed.activities.some(
          (event) => event.kind === "assistant_message" && /PONG/u.test(event.text ?? ""),
        ) || undefined,
      "Claude's answer",
    );
    const submitted = observed.hooks.filter((hook) => hook.hook_event_name === "UserPromptSubmit");
    assert.equal(submitted.length, 1, "the queued message was submitted once");
    assert.ok(
      observed.statuses.some(({ status }) => status === "ready"),
      "the session reached ready",
    );
  } finally {
    await cleanup(session);
    resetRuntimeSeamsForTests();
    launch.dispose();
  }
});
