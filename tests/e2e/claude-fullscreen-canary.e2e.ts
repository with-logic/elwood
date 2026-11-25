/**
 * A user Claude session that died early does not change the renderer the suite's Claude
 * starts with (PRD §12, C-E2E-23). Claude records each fullscreen launch in its global
 * config and clears the record once the launch is healthy; a later launch that finds one
 * for a dead process counts a strike and starts on its main-screen renderer
 * (`docs/cli-behavior.md`). The test leaves a genuine record behind by SIGKILLing a Claude
 * it spawned before that launch is healthy. It then starts Claude from that config twice.
 * From the copy the suite makes of a user config (`privateGlobalConfig`), Claude starts on
 * the alternate screen and counts no strike. From the raw config it counts a strike and
 * starts on the normal buffer, which shows that the keys the copy drops are still the ones
 * Claude reads. No turn runs.
 */

import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node-pty";
import { isRecord } from "../../src/core/predicates.ts";
import type { ClaudeSessionApi } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { pathSkipReason, resolvedAgentProgramPath } from "./availability.ts";
import { privateGlobalConfig } from "./claude-global-config.ts";
import { defaultClaudeConfigDir } from "./claude-home.ts";
import { anthropicCredentialVariables } from "./claude-login.ts";
import { cleanup, makeProject, skipIf, waitFor } from "./helpers.ts";

const globalConfig = join(defaultClaudeConfigDir, ".claude.json");
const recordTimeoutMs = 30_000;
/** Claude can still be switching buffers just after `ready`. */
const settleMs = 2_000;

function readConfig(): Record<string, unknown> {
  const config: unknown = JSON.parse(readFileSync(globalConfig, "utf8"));
  if (!isRecord(config)) throw new Error(`${globalConfig} does not hold a JSON object`);
  return config;
}

/** The PIDs of the fullscreen launches the private config still records. */
function recordedLaunches(): readonly string[] {
  const pending = readConfig()["fullscreenBootPending"];
  return isRecord(pending) ? Object.keys(pending) : [];
}

function writeConfig(text: string): void {
  writeFileSync(globalConfig, text, { mode: 0o600 });
}

/**
 * Spawns Claude itself in a trusted project, waits for it to record its fullscreen launch, and
 * SIGKILLs it, so its exit handlers never clear the record. Claude records the launch as it
 * starts, and marks it healthy only 10 s after its first frame.
 */
async function leaveLaunchRecord(): Promise<void> {
  const cwd = realpathSync(makeProject("claude").cwd);
  const config = readConfig();
  const projects = { [cwd]: { hasTrustDialogAccepted: true } };
  writeConfig(JSON.stringify({ ...config, projects }));
  const env = { ...process.env };
  for (const key of anthropicCredentialVariables) delete env[key];
  const claude = spawn(resolvedAgentProgramPath("claude"), [], { cols: 120, rows: 30, cwd, env });
  const exited = new Promise<void>((resolve) => claude.onExit(() => resolve()));
  try {
    await waitFor(
      () => (recordedLaunches().length > 0 ? true : undefined),
      "Claude records its fullscreen launch",
      recordTimeoutMs,
    );
  } finally {
    process.kill(claude.pid, "SIGKILL"); // only the process this test spawned
    await exited;
  }
}

/** Starts Claude with its default renderer, returns the buffer it shows, and stops it. */
async function defaultBuffer(): Promise<string> {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const started = session;
    await waitFor(() => (started.status === "ready" ? true : undefined), "Claude ready", 120_000);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const { buffer } = await started.readScreen();
    // A graceful stop runs Claude's exit handlers, which clear its own launch record.
    await started.stop();
    return buffer;
  } finally {
    await cleanup(session);
  }
}

test("C-E2E-23 Claude's fullscreen crash tracking stays out of the suite's private config", {
  skip: skipIf(pathSkipReason("claude")),
  timeout: 300_000,
}, async () => {
  const pinned = process.env["CLAUDE_CODE_NO_FLICKER"];
  delete process.env["CLAUDE_CODE_NO_FLICKER"];
  try {
    assert.deepEqual(recordedLaunches(), [], "the private config starts with no record");
    await leaveLaunchRecord();
    const leftover = readFileSync(globalConfig, "utf8");
    assert.equal(recordedLaunches().length, 1, "the killed launch stays recorded");

    writeConfig(privateGlobalConfig(JSON.parse(leftover)));
    assert.equal(await defaultBuffer(), "alternate", "the private copy keeps fullscreen");
    assert.equal(readConfig()["fullscreenBootStrikes"], undefined, "no strike counted");

    writeConfig(leftover);
    assert.equal(await defaultBuffer(), "normal", "the raw config costs a strike");
    const strikes = readConfig()["fullscreenBootStrikes"];
    assert.ok(isRecord(strikes) && strikes["count"] === 1, "Claude counted one strike");
  } finally {
    if (pinned !== undefined) process.env["CLAUDE_CODE_NO_FLICKER"] = pinned;
  }
});
