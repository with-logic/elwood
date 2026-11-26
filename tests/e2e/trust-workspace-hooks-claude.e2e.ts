/**
 * Claude's workspace prompt for a folder whose project settings declare hooks, on the REAL
 * Claude CLI (PRD §5.3, §5.4, §5.13, C-E2E-28, C-CLAUDE-26). Each fresh, untrusted project
 * declares a `SessionStart` hook that writes a marker file, in `.claude/settings.json` or
 * `.claude/settings.local.json`. On Claude 2.1.329 or later, which discloses hooks:
 * `autotrust: true` answers the prompt once, reaches `ready`, and the hook runs. With
 * `autotrust: false`, `listDialogs()` returns the request with `disclosesHooks: true`, no hook
 * runs before the answer, and `answerDialog()` reaches `ready` and runs the hook.
 * `listClaudeModels` refuses the prompt with a typed error, the hook never runs, and the folder
 * stays untrusted. An installed Claude older than 2.1.326 shows the plain prompt for the same
 * project, so `listClaudeModels`, which cannot tell whether it has hooks, refuses that too.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { minimumClaudeVersion } from "../../src/claude/preflight.ts";
import { type ClaudeSessionApi, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import {
  assertProbeRefuses,
  assertStillUntrusted,
  claudeSkip,
  cleanupTimeoutMs,
  listedRequest,
  listTimeoutMs,
  markerTimeoutMs,
  preflightTimeoutMs,
  readyTimeoutMs,
  readyWithMarker,
  refusalTestTimeoutMs,
  disclosingSkip as skip,
} from "./claude-workspace-probe.ts";
import { cleanup, makeProject, skipIf } from "./helpers.ts";
import { installedClaudeBefore, pinInstalledClaude } from "./pinned-claude.ts";

const testTimeoutMs =
  preflightTimeoutMs + listTimeoutMs + readyTimeoutMs + markerTimeoutMs + cleanupTimeoutMs;
/**
 * Claude 2.1.326 through 2.1.328 draw the load row alone, which Elwood never answers. The
 * older-Claude proof needs the plain prompt, so it runs on the newest one before 2.1.326.
 */
const loadRowAloneFrom = "2.1.326";
const older = installedClaudeBefore(loadRowAloneFrom, minimumClaudeVersion);
const olderSkip = older
  ? skipIf(claudeSkip)
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
      await readyWithMarker(session, marker);
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
      await readyWithMarker(started, marker);
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
    await assertProbeRefuses(project, "workspace_hooks", marker);
    await assertStillUntrusted(project, { marker, disclosesHooks: true });
  });
}

test(`C-E2E-28 listClaudeModels on Claude ${older ?? "older"} refuses a plain workspace prompt`, {
  skip: olderSkip,
  timeout: refusalTestTimeoutMs,
}, async (t) => {
  assert.ok(older, "skipped unless an older Claude is installed");
  t.after(pinInstalledClaude(older));
  const { project, marker } = hookedProject();
  await assertProbeRefuses(project, "workspace_hooks", marker);
  // The older CLI shows the plain prompt for the same folder: it never discloses its hooks.
  await assertStillUntrusted(project, { marker, disclosesHooks: false });
});
