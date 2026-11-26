/**
 * Claude's workspace prompt for a folder whose settings pre-approve tool permissions, against
 * the REAL Claude CLI (PRD §5.3, §5.4, C-E2E-29, C-CLAUDE-30), each in a fresh, untrusted
 * project on Claude 2.1.329 or later. For one pre-approved permission, the probe refuses the
 * folder with the load row's category and leaves it untrusted, and autotrust answers the
 * workspace prompt once and reaches `ready`. When the settings also add a workspace directory,
 * whose warning Claude closes with the same sentence, the probe rejects the prompt it cannot
 * verify.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { ClaudeSessionApi } from "../../src/index.ts";
import {
  assertProbeRefuses,
  assertStillUntrusted,
  autotrusted,
  cleanupTimeoutMs,
  preflightTimeoutMs,
  readyTimeoutMs,
  refusalTestTimeoutMs,
  disclosingSkip as skip,
  writeJson,
} from "./claude-workspace-probe.ts";
import { cleanup, type E2eProject, makeProject, waitFor } from "./helpers.ts";

const testTimeoutMs = preflightTimeoutMs + readyTimeoutMs + cleanupTimeoutMs;

/** A project whose `.claude/settings.json` sets `permissions`. */
function permissionsProject(permissions: object): E2eProject {
  const project = makeProject("claude");
  writeJson(join(project.cwd, ".claude", "settings.json"), { permissions });
  return project;
}

const oneRule = { allow: ["Bash(ls:*)"] };

test("C-E2E-29 listClaudeModels refuses a folder whose settings pre-approve a tool permission", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const project = permissionsProject(oneRule);
  await assertProbeRefuses(project, "workspace_settings");
  await assertStillUntrusted(project, undefined, false);
});

test("C-E2E-29 autotrust trusts a folder whose settings pre-approve a tool permission", {
  skip,
  timeout: testTimeoutMs,
}, async () => {
  const project = permissionsProject(oneRule);
  let session: ClaudeSessionApi | undefined;
  try {
    const started = await autotrusted(project);
    const live = started.session;
    session = live;
    await waitFor(() => (live.status === "ready" ? true : undefined), "ready", readyTimeoutMs);
    assert.deepEqual(started.answers, ["workspace_trust"]);
    await live.stop();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-29 listClaudeModels rejects a prompt for settings that also add a workspace directory", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const project = permissionsProject({ ...oneRule, additionalDirectories: ["./extra"] });
  await assertProbeRefuses(project, "workspace_unverified");
});
