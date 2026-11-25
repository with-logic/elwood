/**
 * A turn the real Codex CLI rejects reaches a raw `activity` listener as `turn_failure`.
 * Real-CLI proof of PRD §5.4 and C-API-65. Codex fires no `Stop` and writes no reply: its
 * failed `task_complete` record is the only evidence, and the screen usually reaches
 * `ready` before Elwood reads it. A bogus `--model` is refused before any quota is consumed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  bogusCodexModel,
  codexAuthMissing,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";
import {
  isTurnFailure,
  turnFailureWaitMs,
  turnReadyIndex,
  turnReadyWaitMs,
  waitWithEvidence,
} from "./turn-failure.ts";

const config = "check_for_update_on_startup = false\n";

/** The payload and error of a failed `task_complete` record, or `undefined` for any other item. */
function failedTask(item: unknown) {
  const payload = isRecord(item) ? item["payload"] : undefined;
  if (!isRecord(payload) || payload["type"] !== "task_complete") return undefined;
  return isRecord(payload["error"]) ? { payload, error: payload["error"] } : undefined;
}

test("C-API-65 a rejected real Codex turn reaches a raw activity listener as turn_failure", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: e2eTimeoutMs + 30_000,
}, async (t) => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, config);
  const launches = codexLaunches();
  let session: CodexSessionApi | undefined;
  await runCodexTest({ sessions: () => [session], sandbox, launches }, async () => {
    session = await launches.track(
      startCodex({
        cwd: project.cwd,
        stateDir: project.stateDir,
        model: bogusCodexModel,
        sandbox: "read-only",
        approvalPolicy: "never",
        autotrust: true,
      }),
    );
    const observed = observeSession(session);
    const { activities } = observed;
    const turnStartIndex = activities.length;
    await session.sendMessage("Reply with exactly OK.");
    // Wait as a consumer that ends the turn on `ready` would, then keep listening. PRD §5.4
    // does not order `turn_failure` against `ready`, so this proves delivery either way and
    // records the order it observed.
    const readyIndex = await waitWithEvidence(
      () => turnReadyIndex(activities, turnStartIndex),
      "the turn's ready",
      turnReadyWaitMs,
      session,
      observed,
    );
    const failure = await waitWithEvidence(
      () => activities.find(isTurnFailure),
      "turn_failure",
      turnFailureWaitMs,
      session,
      observed,
    );
    const failureIndex = activities.indexOf(failure);
    t.diagnostic(`ready ${readyIndex < failureIndex ? "preceded" : "followed"} turn_failure`);
    const failedEvent = observed.transcripts.find((event) => failedTask(event.item));
    const task = failedTask(failedEvent?.item);
    assert.ok(failedEvent && task, "Codex committed a failed task_complete");
    assert.equal(failure.agent, "codex");
    assert.equal(failure.source, "transcript");
    assert.equal(failure.transcriptPath, failedEvent.path);
    assert.equal(failure.label, "model_unavailable");
    assert.equal(failure.turnFailure.category, "model_unavailable");
    assert.equal(failure.turnFailure.disposition, "final");
    // Codex's own nonblank words from the record, not a sentence Elwood wrote.
    assert.equal(failure.turnFailure.message, task.error["message"]);
    assert.notEqual(failure.turnFailure.message.trim(), "");
    // The failure names the turn the submit hook started.
    const submit = activities.find((event) => event.hookEventName === "UserPromptSubmit");
    assert.ok(submit?.turnId, "the submit hook names the turn");
    assert.equal(task.payload["turn_id"], submit.turnId);
    assert.equal(failure.turnId, submit.turnId);
    // It follows the record's own activity, and the session is `ready` once it has landed.
    assert.equal(activities[failureIndex - 1]?.raw, failedEvent.item);
    assert.equal(session.status, "ready");
    // Counted after teardown's final transcript flush, so a late duplicate would be seen.
    await session.teardown();
    assert.equal(activities.filter(isTurnFailure).length, 1);
    // Codex fired no `Stop` and wrote no reply: this activity is the turn's only outcome.
    assert.ok(!observed.hooks.some((event) => event.hook_event_name === "Stop"));
    assert.ok(!activities.some((event) => event.kind === "assistant_message"));
    observed.dispose();
  });
});
