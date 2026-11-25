/**
 * A turn the real Claude CLI rejects reaches a raw `activity` listener as `turn_failure`.
 * Real-CLI proof of PRD §5.4 and C-API-65. Claude fires `StopFailure` instead of `Stop`, and
 * its screen usually reaches `ready` first, so the listener keeps listening past `ready`.
 * A bogus `--model` is refused before any model quota is consumed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeHookEventFor, type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";
import { isTurnFailure, turnReady } from "./turn-failure.ts";

const bogusModel = "elwood-bogus-model";

test("C-API-65 a rejected real Claude turn reaches a raw activity listener as turn_failure", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async (t) => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      model: bogusModel,
      permissionMode: "bypassPermissions",
      autotrust: true,
    });
    const observed = observeSession(session);
    const { activities } = observed;
    const sent = activities.length;
    await session.sendMessage("Reply with exactly OK.");
    // Wait as a consumer that ends the turn on `ready` would, then keep listening.
    const ready = await waitFor(() => turnReady(activities, sent), "the turn's ready");
    const failure = await waitFor(() => activities.find(isTurnFailure), "turn_failure", 90_000);
    const submit = activities.find((event) => event.hookEventName === "UserPromptSubmit");
    const native = observed.hooks.find(
      (event): event is ClaudeHookEventFor<"StopFailure"> =>
        event.hook_event_name === "StopFailure",
    );
    assert.ok(native, "Claude fired StopFailure");
    t.diagnostic(`ready ${ready < activities.indexOf(failure) ? "preceded" : "followed"} it`);
    assert.equal(failure.agent, "claude");
    assert.equal(failure.source, "hook");
    assert.equal(failure.hookEventName, "StopFailure");
    assert.equal(native.error, "model_not_found");
    assert.equal(failure.label, "model_unavailable");
    assert.equal(failure.turnFailure.category, "model_unavailable");
    assert.equal(failure.turnFailure.disposition, "final");
    // Claude sends no `error_details` here, so the diagnostic is the §6.1 fallback naming
    // the hook's own code, never the error Claude rendered as `last_assistant_message`.
    assert.equal(native.error_details, undefined);
    assert.equal(failure.turnFailure.message, "Claude rejected the turn: model_not_found");
    assert.notEqual(failure.turnFailure.message, native.last_assistant_message);
    // The failure names the turn the submit hook started.
    assert.ok(submit?.turnId, "the submit hook names the turn");
    assert.equal(native["prompt_id"], submit.turnId);
    assert.equal(failure.turnId, submit.turnId);
    // It follows the native hook's own activity, and a late one does not reopen the turn.
    const preceding = activities[activities.indexOf(failure) - 1];
    assert.equal(preceding?.kind, "hook");
    assert.equal(preceding?.label, "StopFailure");
    assert.equal(activities.filter(isTurnFailure).length, 1);
    assert.equal(session.status, "ready");
    assert.ok(!observed.hooks.some((event) => event.hook_event_name === "Stop"));
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
