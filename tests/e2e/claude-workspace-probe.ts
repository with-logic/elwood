/**
 * Shared proof steps for Claude's workspace prompt on the REAL Claude CLI (PRD §5.3, §5.4,
 * C-E2E-28, C-E2E-29): the skip for a Claude that does not disclose hooks, the timeouts, a
 * project's settings files, an autotrust session and the prompts it answers, a trusted
 * session's readiness with the folder's code, and the model probe's refusal that leaves the
 * folder untrusted.
 */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: these checks are each proof's own assertions.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProbeRefusalCategory } from "../../src/claude/list-models.ts";
import { claudeHooksDisclosureVersion } from "../../src/claude/preflight.ts";
import { compareVersions } from "../../src/core/versions.ts";
import {
  type ClaudeSessionApi,
  ElwoodError,
  listClaudeModels,
  startClaude,
} from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { cleanup, type E2eProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { installedClaudeVersion } from "./pinned-claude.ts";

/** From launch to Claude's ready composer, as elsewhere in the suite. */
export const readyTimeoutMs = 120_000;
/** Claude paints its trust prompt within seconds of launch; the probe's readiness wait is 60 s. */
export const listTimeoutMs = 60_000;
/** The folder's hook or MCP server runs as the trusted session starts. */
export const markerTimeoutMs = 30_000;
/** A graceful stop and the scratch project's removal. */
export const cleanupTimeoutMs = 60_000;
/** The preflight's login shell and `claude --version`, which the first launch pays. */
export const preflightTimeoutMs = probeLaunchTimeoutMs + probeCommandTimeoutMs;
/** The probe, bounded by its own 60 s readiness wait, then a later session's listing. */
export const refusalTestTimeoutMs = preflightTimeoutMs + 2 * listTimeoutMs + cleanupTimeoutMs;

export const claudeSkip = skipReason("claude");
const installed = await installedClaudeVersion(claudeSkip);
const disclosing =
  installed !== null && compareVersions(installed, claudeHooksDisclosureVersion) >= 0;
/** Skips unless the installed Claude discloses hooks, the only one the probe answers. */
export const disclosingSkip = skipIf(
  claudeSkip,
  !disclosing && `requires Claude ${claudeHooksDisclosureVersion}+, which discloses hooks`,
);

/** Writes `body` as JSON at `path`, creating its directory. */
export function writeJson(path: string, body: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

/** Starts an autotrust session and returns it with the trust prompts it answers, in order. */
export async function autotrusted(project: E2eProject) {
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  });
  const answers: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt") answers.push(String(event.label));
  });
  return { session, answers };
}

/** The session reaches `ready`, and then the folder's code writes `marker`. */
export async function readyWithMarker(session: ClaudeSessionApi, marker: string): Promise<void> {
  const ready = () => (session.status === "ready" ? true : undefined);
  await waitFor(ready, "Claude ready", readyTimeoutMs);
  const written = () => (existsSync(marker) ? true : undefined);
  await waitFor(written, "the folder's code runs", markerTimeoutMs);
}

/** The session's listed workspace trust request, once Claude paints the prompt. */
export async function listedRequest(session: ClaudeSessionApi) {
  const listed = async () => (await session.listDialogs())[0];
  return await waitFor(listed, "Claude lists its workspace trust request", listTimeoutMs);
}

/**
 * The probe rejects with `category`, not a readiness timeout, and never runs the code that
 * writes `marker`. The category alone tells the two apart, so no wall-clock bound is asserted.
 */
export async function assertProbeRefuses(
  project: E2eProject,
  category: ProbeRefusalCategory,
  marker?: string,
): Promise<void> {
  const refused = await listClaudeModels({ cwd: project.cwd, stateDir: project.stateDir }).then(
    (models) => assert.fail(`the probe listed ${models.length} models`),
    (error: unknown) => error,
  );
  assert.ok(refused instanceof ElwoodError, `a typed refusal, not ${String(refused)}`);
  assert.equal(refused.code, "claude_start_failed");
  assert.deepEqual(refused.details, { category });
  if (marker !== undefined)
    assert.equal(existsSync(marker), false, "the probe never ran the folder's code");
}

/**
 * A later session in the project is shown the workspace prompt again: it is still untrusted,
 * and the code that writes `marker`, when the folder has any, has not run.
 */
export async function assertStillUntrusted(
  project: E2eProject,
  marker: string | undefined,
  disclosesHooks: boolean,
): Promise<void> {
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: false });
    const request = await listedRequest(session);
    assert.equal(request.disclosesHooks, disclosesHooks, "the folder is still untrusted");
    if (marker !== undefined)
      assert.equal(existsSync(marker), false, "none of the folder's code has run");
  } finally {
    await cleanup(session);
  }
}
