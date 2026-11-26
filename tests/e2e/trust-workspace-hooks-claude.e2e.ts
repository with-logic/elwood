/**
 * Claude's workspace prompt for a folder whose project settings declare hooks, on the REAL
 * Claude CLI (PRD §5.3, §5.4, §5.13, C-E2E-28, C-CLAUDE-26). Each fresh, untrusted project
 * declares a `SessionStart` hook that writes a marker file, so the marker shows the hook ran,
 * in `.claude/settings.json` or `.claude/settings.local.json`. On Claude 2.1.329 or later,
 * which discloses hooks: `autotrust: true` answers the prompt once, reaches `ready`, and the
 * hook runs. With `autotrust: false`, `listDialogs()` returns the workspace request with
 * `disclosesHooks: true`, no hook runs before the answer, and answering its affirmative with
 * `answerDialog()` reaches `ready` and runs the hook. `listClaudeModels` refuses the prompt
 * with a typed error, the hook never runs, and the folder stays untrusted. An installed Claude
 * older than 2.1.326 shows the plain prompt for the same project, so `listClaudeModels`, which
 * cannot tell whether its folder has hooks, refuses that prompt too.
 */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: the refusal and untrusted checks are shared by every version's proof.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { claudeHooksDisclosureVersion, minimumClaudeVersion } from "../../src/claude/preflight.ts";
import { compareVersions, parseVersion } from "../../src/core/versions.ts";
import {
  type ClaudeSessionApi,
  type ElwoodActivityEvent,
  ElwoodError,
  listClaudeModels,
  startClaude,
} from "../../src/index.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeShellCommand, shellQuote, userShell } from "../../src/runtime/shell.ts";
import { cleanup, type E2eProject, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { installedClaudeBefore, pinInstalledClaude } from "./pinned-claude.ts";

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
const refusalTestTimeoutMs = refusalTimeoutMs + listTimeoutMs + cleanupTimeoutMs;

const installed = parseVersion(
  (await runProbe(userShell(), probeShellCommand("claude --version", "claude"))).stdout,
);
const disclosing =
  installed !== null && compareVersions(installed, claudeHooksDisclosureVersion) >= 0;
const skip = skipIf(
  skipReason("claude"),
  !disclosing && `requires Claude ${claudeHooksDisclosureVersion}+, which discloses hooks`,
);
/**
 * Claude 2.1.326 through 2.1.328 draw the load row alone, which Elwood never answers. The
 * older-Claude proof needs the plain prompt, so it runs on the newest one before 2.1.326.
 */
const loadRowAloneFrom = "2.1.326";
const older = installedClaudeBefore(loadRowAloneFrom, minimumClaudeVersion);
const olderSkip = older
  ? skipIf(skipReason("claude"))
  : `requires an installed Claude below ${loadRowAloneFrom}`;

/** The project settings files Claude loads on trust, each disclosed by name. */
const settingsFiles = ["settings.json", "settings.local.json"] as const;
type SettingsFile = (typeof settingsFiles)[number];

/** A scratch project whose `file` declares a `SessionStart` hook that writes `marker`. */
function hookedProject(file: SettingsFile = "settings.json") {
  const project = makeProject("claude");
  const marker = join(project.cwd, "session-start-hook-ran");
  const command = `touch ${shellQuote(marker)}`;
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command }] }] };
  mkdirSync(join(project.cwd, ".claude"));
  writeFileSync(join(project.cwd, ".claude", file), JSON.stringify({ hooks }));
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

/** The probe rejects with the typed refusal, well before readiness, without running the hook. */
async function assertProbeRefuses(project: E2eProject, marker: string): Promise<void> {
  const startedAt = performance.now();
  const refused = await listClaudeModels({ cwd: project.cwd, stateDir: project.stateDir }).then(
    (models) => assert.fail(`the probe listed ${models.length} models`),
    (error: unknown) => error,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(refused instanceof ElwoodError, `a typed refusal, not ${String(refused)}`);
  assert.equal(refused.code, "claude_start_failed");
  assert.deepEqual(refused.details, { category: "workspace_hooks" });
  assert.ok(
    elapsedMs < refusalTimeoutMs,
    `refused after ${elapsedMs} ms, before readiness ran out`,
  );
  assert.equal(existsSync(marker), false, "the probe never ran the folder's hook");
}

/** A later session in the project is shown the workspace prompt again: it is still untrusted. */
async function assertStillUntrusted(project: E2eProject, marker: string, disclosed: boolean) {
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: false });
    const request = await listedRequest(session);
    assert.equal(request.disclosesHooks, disclosed, "the folder is still untrusted");
    assert.equal(existsSync(marker), false, "no hook has run");
  } finally {
    await cleanup(session);
  }
}

for (const file of settingsFiles) {
  test(`C-E2E-28 autotrust approves Claude's prompt for a folder whose ${file} declares hooks`, {
    skip,
    timeout: testTimeoutMs,
  }, async () => {
    const { project, marker } = hookedProject(file);
    let session: ClaudeSessionApi | undefined;
    try {
      session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      const answers: ElwoodActivityEvent[] = [];
      // startClaude returns before Claude paints its composer, which verifies the answer.
      session.on("activity", (event) => {
        if (event.kind === "startup_prompt" && event.label === "workspace_trust")
          answers.push(event);
      });
      await readyWithHookRun(session, marker);
      assert.equal(answers.length, 1, "autotrust answered the workspace prompt exactly once");
      await session.stop();
    } finally {
      await cleanup(session);
    }
  });

  test(`C-E2E-28 answerDialog approves a listed request whose ${file} declares hooks`, {
    skip,
    timeout: testTimeoutMs,
  }, async () => {
    const { project, marker } = hookedProject(file);
    let session: ClaudeSessionApi | undefined;
    try {
      session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: false,
      });
      const started = session;
      const request = await listedRequest(started);
      assert.equal(request.disclosesHooks, true, "the request discloses the folder's hooks");
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

  test(`C-E2E-28 listClaudeModels refuses a folder whose ${file} declares hooks`, {
    skip,
    timeout: refusalTestTimeoutMs,
  }, async () => {
    const { project, marker } = hookedProject(file);
    await assertProbeRefuses(project, marker);
    await assertStillUntrusted(project, marker, true);
  });
}

test(`C-E2E-28 listClaudeModels on Claude ${older ?? "older"} refuses a plain workspace prompt`, {
  skip: olderSkip,
  timeout: refusalTestTimeoutMs,
}, async (t) => {
  assert.ok(older, "skipped unless an older Claude is installed");
  t.after(pinInstalledClaude(older));
  const { project, marker } = hookedProject();
  await assertProbeRefuses(project, marker);
  // The older CLI shows the plain prompt for the same folder: it never discloses its hooks.
  await assertStillUntrusted(project, marker, false);
});
