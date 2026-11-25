/**
 * A user Claude session that died early does not change the renderer the suite's Claude
 * starts with (PRD §12, C-E2E-23). Claude records each fullscreen launch in its global
 * config and clears the record once the launch is healthy; a later launch that finds one
 * for a dead process counts a strike and starts on its main-screen renderer
 * (`docs/cli-behavior.md`). The test leaves a genuine record behind by SIGKILLing a Claude
 * it spawned before that launch is healthy. It then starts Claude from that config twice.
 * From the copy the suite makes of a user config (`privateGlobalConfig`), Claude starts on
 * the alternate screen and counts no strike. From the raw config it counts a strike and
 * starts on the normal buffer, which shows that Claude still reads the pending-launch
 * record the copy drops. The copy also drops the strike count and the auto-disable flag;
 * this test does not give Claude either of those. No turn runs.
 */

import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import { isRecord } from "../../src/core/predicates.ts";
import type { ClaudeSessionApi } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { pathSkipReason, resolvedAgentProgramPath } from "./availability.ts";
import { parseGlobalConfig, privateGlobalConfig } from "./claude-global-config.ts";
import { defaultClaudeConfigDir } from "./claude-home.ts";
import { anthropicCredentialVariables } from "./claude-login.ts";
import { cleanup, makeProject, skipIf, waitFor } from "./helpers.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";

const globalConfig = join(defaultClaudeConfigDir, ".claude.json");
/** Claude writes its launch record as it starts, before its first frame. */
const recordTimeoutMs = 30_000;
/** From launch to Claude's ready composer, as elsewhere in the suite. */
const readyTimeoutMs = 120_000;
/** Claude can still be switching buffers just after `ready`. */
const rendererTimeoutMs = 20_000;
/** How long a buffer must hold to count as the one Claude settled on. */
const rendererHoldMs = 2_000;
const rendererPollMs = 250;
/** A graceful stop and the scratch project's removal. */
const cleanupTimeoutMs = 60_000;
const testTimeoutMs =
  recordTimeoutMs + 2 * (readyTimeoutMs + rendererTimeoutMs + rendererHoldMs + cleanupTimeoutMs);

function readConfig(): Record<string, unknown> {
  return parseGlobalConfig(readFileSync(globalConfig, "utf8"), globalConfig);
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
  let running = true;
  const exited = new Promise<void>((resolve) =>
    claude.onExit(() => {
      running = false;
      resolve();
    }),
  );
  try {
    await waitFor(
      () => {
        if (!running) throw new Error("Claude exited before it recorded its fullscreen launch");
        return recordedLaunches().length > 0 ? true : undefined;
      },
      "Claude records its fullscreen launch",
      recordTimeoutMs,
    );
  } finally {
    // Only through the handle of the child this test spawned, and only while it runs, so the
    // signal cannot reach a process that reused its PID. node-pty's kill() never throws.
    if (running) claude.kill("SIGKILL");
    await exited;
  }
}

/** The buffer Claude settled on: `expected` once it held for `rendererHoldMs`, else the last read. */
async function settledBuffer(session: ClaudeSessionApi, expected: string): Promise<string> {
  const deadline = Date.now() + rendererTimeoutMs;
  let heldSince: number | undefined;
  for (;;) {
    const { buffer } = await session.readScreen();
    heldSince = buffer === expected ? (heldSince ?? Date.now()) : undefined;
    if (heldSince !== undefined && Date.now() - heldSince >= rendererHoldMs) return buffer;
    if (Date.now() >= deadline) return buffer;
    await delay(rendererPollMs);
  }
}

/**
 * Starts Claude with its default renderer, returns the buffer it settles on, and stops it.
 * The launch shell unsets `CLAUDE_CODE_NO_FLICKER` after the developer's startup files run,
 * since either value of it picks a renderer and skips the crash check.
 */
async function startedBuffer(expected: string): Promise<string> {
  setPtyFactoryForTests((options) =>
    nodePtyFactory({
      ...options,
      args: prefixShellArgument(options.args, "unset CLAUDE_CODE_NO_FLICKER || exit 1"),
    }),
  );
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const started = session;
    const ready = () => (started.status === "ready" ? true : undefined);
    await waitFor(ready, "Claude ready", readyTimeoutMs);
    const buffer = await settledBuffer(started, expected);
    // A graceful stop runs Claude's exit handlers, which clear its own launch record.
    await started.stop();
    return buffer;
  } finally {
    await cleanup(session);
    resetRuntimeSeamsForTests();
  }
}

test("C-E2E-23 Claude's fullscreen crash tracking stays out of the suite's private config", {
  skip: skipIf(pathSkipReason("claude")),
  timeout: testTimeoutMs,
}, async () => {
  assert.deepEqual(recordedLaunches(), [], "the private config starts with no record");
  await leaveLaunchRecord();
  const leftover = readFileSync(globalConfig, "utf8");
  assert.equal(recordedLaunches().length, 1, "the killed launch stays recorded");

  writeConfig(privateGlobalConfig(parseGlobalConfig(leftover, globalConfig)));
  assert.equal(await startedBuffer("alternate"), "alternate", "the private copy keeps fullscreen");
  assert.equal(readConfig()["fullscreenBootStrikes"], undefined, "no strike counted");

  writeConfig(leftover);
  assert.equal(await startedBuffer("normal"), "normal", "the raw config costs a strike");
  const strikes = readConfig()["fullscreenBootStrikes"];
  assert.ok(isRecord(strikes) && strikes["count"] === 1, "Claude counted one strike");
});
