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
  waitFor,
} from "./helpers.ts";
import { isTurnFailure, turnReady } from "./turn-failure.ts";

const config = "check_for_update_on_startup = false\n";

/** The payload of a failed `task_complete` record, or `undefined` for any other item. */
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
    const sent = activities.length;
    await session.sendMessage("Reply with exactly OK.");
    // Wait as a consumer that ends the turn on `ready` would, then keep listening.
    const ready = await waitFor(() => turnReady(activities, sent), "the turn's ready");
    const failure = await waitFor(() => activities.find(isTurnFailure), "turn_failure", 90_000);
    const native = observed.transcripts.find((event) => failedTask(event.item));
    const task = failedTask(native?.item);
    assert.ok(native && task, "Codex committed a failed task_complete");
    t.diagnostic(`ready ${ready < activities.indexOf(failure) ? "preceded" : "followed"} it`);
    assert.equal(failure.agent, "codex");
    assert.equal(failure.source, "transcript");
    assert.equal(failure.transcriptPath, native.path);
    assert.equal(failure.label, "model_unavailable");
    assert.equal(failure.turnFailure.category, "model_unavailable");
    assert.equal(failure.turnFailure.disposition, "final");
    // Codex's own words from the record, which name the model it refused.
    assert.equal(failure.turnFailure.message, task.error["message"]);
    assert.ok(failure.turnFailure.message.includes(bogusCodexModel), failure.turnFailure.message);
    // The failure names the turn the submit hook started.
    const submit = activities.find((event) => event.hookEventName === "UserPromptSubmit");
    assert.ok(submit?.turnId, "the submit hook names the turn");
    assert.equal(task.payload["turn_id"], submit.turnId);
    assert.equal(failure.turnId, submit.turnId);
    // It follows the record's own activity, and a late one does not reopen the turn.
    assert.equal(activities[activities.indexOf(failure) - 1]?.raw, native.item);
    assert.equal(activities.filter(isTurnFailure).length, 1);
    assert.equal(session.status, "ready");
    // Codex fired no `Stop` and wrote no reply: this activity is the turn's only outcome.
    assert.ok(!observed.hooks.some((event) => event.hook_event_name === "Stop"));
    assert.ok(!activities.some((event) => event.kind === "assistant_message"));
    observed.dispose();
  });
});
