/**
 * Claude's workspace prompt for a folder whose `.claude/settings.json` declares hooks, on the
 * REAL Claude CLI (PRD §5.3, §5.4, §5.13, C-E2E-28, C-CLAUDE-26). Each fresh, untrusted
 * project declares a `SessionStart` hook that writes a marker file, so the marker shows the
 * hook ran. `autotrust: true` answers the prompt once, reaches `ready`, and the hook runs.
 * With `autotrust: false`, `listDialogs()` returns the workspace request with
 * `targetDeclaresHooks: true`, no hook runs before the answer, and answering its affirmative
 * with `answerDialog()` reaches `ready` and runs the hook. `listClaudeModels` refuses the
 * prompt with a typed error, the hook never runs, and the folder stays untrusted.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  type ClaudeSessionApi,
  type ElwoodActivityEvent,
  ElwoodError,
  listClaudeModels,
  startClaude,
} from "../../src/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";

/** From launch to Claude's ready composer, as elsewhere in the suite. */
const readyTimeoutMs = 120_000;
/** Claude paints its trust prompt within seconds of launch; listing needs it settled. */
const listTimeoutMs = 60_000;
/** The `SessionStart` hook runs as the trusted session starts. */
const hookTimeoutMs = 30_000;
/** A graceful stop and the scratch project's removal. */
const cleanupTimeoutMs = 60_000;
/** The probe waits 60 s for readiness; a refusal must come well before that. */
const refusalTimeoutMs = 45_000;
const testTimeoutMs = listTimeoutMs + readyTimeoutMs + hookTimeoutMs + cleanupTimeoutMs;
const skip = skipIf(skipReason("claude"));

/** A scratch project whose settings declare a `SessionStart` hook that writes `marker`. */
function hookedProject() {
  const project = makeProject("claude");
  const marker = join(project.cwd, "session-start-hook-ran");
  const command = `touch ${shellQuote(marker)}`;
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command }] }] };
  mkdirSync(join(project.cwd, ".claude"));
  writeFileSync(join(project.cwd, ".claude", "settings.json"), JSON.stringify({ hooks }));
  return { project, marker };
}

async function readyWithHookRun(session: ClaudeSessionApi, marker: string): Promise<void> {
  const ready = () => (session.status === "ready" ? true : undefined);
  await waitFor(ready, "Claude ready", readyTimeoutMs);
  const ran = () => (existsSync(marker) ? true : undefined);
  await waitFor(ran, "the folder's SessionStart hook runs", hookTimeoutMs);
}

/** The session's listed workspace trust request, once Claude paints the prompt. */
async function listedRequest(session: ClaudeSessionApi) {
  const listed = async () => (await session.listDialogs())[0];
  return await waitFor(listed, "Claude lists its workspace trust request", listTimeoutMs);
}

test("C-E2E-28 autotrust approves Claude's prompt for a folder that declares hooks", {
  skip,
  timeout: testTimeoutMs,
}, async () => {
  const { project, marker } = hookedProject();
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const answers: ElwoodActivityEvent[] = [];
    // startClaude returns before Claude paints its composer, which verifies the answer.
    session.on("activity", (event) => {
      if (event.kind === "startup_prompt" && event.label === "workspace_trust") answers.push(event);
    });
    await readyWithHookRun(session, marker);
    assert.equal(answers.length, 1, "autotrust answered the workspace prompt exactly once");
    await session.stop();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-28 answerDialog approves a listed request that declares hooks", {
  skip,
  timeout: testTimeoutMs,
}, async () => {
  const { project, marker } = hookedProject();
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: false });
    const started = session;
    const request = await listedRequest(started);
    assert.equal(request.targetDeclaresHooks, true, "the request says the folder declares hooks");
    assert.equal(request.targetPath, realpathSync(project.cwd));
    assert.equal(existsSync(marker), false, "no hook runs before the folder is trusted");
    const yes = request.choices.find(({ label }) => label === "Yes, I trust this folder");
    assert.ok(yes, `an affirmative choice among ${JSON.stringify(request.choices)}`);
    await started.answerDialog(request.id, yes.id);
    await readyWithHookRun(started, marker);
    await started.stop();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-28 listClaudeModels refuses a folder that declares hooks and leaves it untrusted", {
  skip,
  timeout: refusalTimeoutMs + listTimeoutMs + cleanupTimeoutMs,
}, async () => {
  const { project, marker } = hookedProject();
  const startedAt = Date.now();
  const refused = await listClaudeModels({ cwd: project.cwd, stateDir: project.stateDir }).then(
    (models) => assert.fail(`the probe listed ${models.length} models`),
    (error: unknown) => error,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(refused instanceof ElwoodError, `a typed refusal, not ${String(refused)}`);
  assert.equal(refused.code, "claude_start_failed");
  assert.deepEqual(refused.details, { category: "workspace_hooks" });
  assert.ok(
    elapsedMs < refusalTimeoutMs,
    `refused after ${elapsedMs} ms, before readiness ran out`,
  );
  assert.equal(existsSync(marker), false, "the probe never ran the folder's hook");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: false });
    const request = await listedRequest(session);
    assert.equal(request.targetDeclaresHooks, true, "the folder is still untrusted");
    assert.equal(existsSync(marker), false, "no hook has run");
  } finally {
    await cleanup(session);
  }
});
