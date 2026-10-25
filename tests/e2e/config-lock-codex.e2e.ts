/**
 * Real-CLI verification that two concurrent Codex sessions switching models do NOT
 * cross-persist a model as the user's global default (PRD C-CODEX-14). The config
 * lock must serialize each session's snapshot→apply→compare-and-swap-restore over
 * the shared config.toml so the prior default is restored regardless of interleaving.
 *
 * Safety: this runs entirely inside a SANDBOXED CODEX_HOME seeded with only the
 * user's real auth.json (`sandboxedCodexHome`) — it never reads or writes the real
 * ~/.codex/config.toml, and the sandbox is removed only AFTER both sessions are torn
 * down, so an in-flight session can never rewrite a restored file. The happy-path
 * single-session restore is covered by model-picker.e2e.ts; this pins the lock.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";

// A known baseline default the sandbox starts from; concurrent switches must restore it.
const BASELINE_CONFIG = 'model = "gpt-5.1-codex"\nmodel_reasoning_effort = "medium"\n';

// This test's own deadline for each start, independent of the `waitForStatus` default:
// two starts in sequence plus the switches must fit the 240 s test timeout.
const readyTimeoutMs = 60_000;

/** The root model defaults in the sandbox config, which must survive concurrent switches. */
function rootModelKeys(configPath: string): readonly string[] {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return text.split("\n").filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line));
}

/** Tears a session down, falling back to kill; returns what failed rather than hiding it. */
async function stop(session: CodexSessionApi): Promise<unknown[]> {
  try {
    await session.teardown();
    return [];
  } catch (teardownError) {
    try {
      await session.kill();
      return [];
    } catch (killError) {
      return [teardownError, killError];
    }
  }
}

/**
 * Starts one session, adds it to `started` so the caller can always tear it down, and
 * waits for it to become ready. A session that does not is torn down here first, so the
 * error carries the CLI's final screen: Codex prints its startup error last, and teardown
 * drains output that arrives after the exit (PRD §9.4) before disposing the terminal.
 */
async function startReady(started: CodexSessionApi[]): Promise<CodexSessionApi> {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  started.push(session);
  // `terminal:data` fires once each chunk has rendered, so this copy is always the latest
  // screen, taken while the terminal is still live.
  let screen = "";
  const offScreen = session.on("terminal:data", () => {
    screen = session.terminal.snapshot().text.trim();
  });
  try {
    // Rejects as soon as the session reaches a terminal status such as `exited`,
    // rather than waiting out the deadline for a `ready` that cannot come.
    await session.waitForStatus((status) => status === "ready", readyTimeoutMs);
    return session;
  } catch (error) {
    const status = session.status;
    const cleanupFailures = await stop(session);
    const cleanupNote = cleanupFailures.length
      ? `\ncleanup also failed: ${cleanupFailures.map(String).join("; ")}`
      : "";
    throw new Error(`codex did not become ready (status ${status}):\n${screen}${cleanupNote}`, {
      cause: error,
    });
  } finally {
    offScreen();
  }
}

test("C-CODEX-14 concurrent Codex model switches restore the user default (real CLI)", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 240_000,
}, async () => {
  const sandbox = sandboxedCodexHome(makeProject("codex"), BASELINE_CONFIG);
  const defaultsBefore = rootModelKeys(sandbox.configPath);
  const started: CodexSessionApi[] = [];
  const failures: unknown[] = [];
  try {
    // Start the sessions one after the other; the concurrency under test is the model
    // switch below. Codex 0.164.0 does not serialize its SQLite migrations across
    // processes, so two cold starts in this fresh sandbox race them and one exits with
    // "local database appears to be damaged" (docs/cli-behavior.md).
    const a = await startReady(started);
    const b = await startReady(started);
    const models = await a.listModels();
    const target = models.find((model) => !model.isCurrent);
    assert.ok(target, "another model is available to switch to");
    // Switch BOTH sessions to the same non-default model at once. Without the config
    // lock the two snapshot/restore transactions interleave on the shared config.toml
    // and can leave `target` persisted as the default.
    await Promise.all([a.setModel(target.id), b.setModel(target.id)]);
    assert.equal((await a.listModels()).find((m) => m.isCurrent)?.id, target.id, "A switched");
    assert.equal((await b.listModels()).find((m) => m.isCurrent)?.id, target.id, "B switched");
    // The GLOBAL default on disk is restored to the baseline despite concurrent switches.
    assert.deepEqual(
      rootModelKeys(sandbox.configPath),
      defaultsBefore,
      "the config.toml model default is restored despite concurrent switches",
    );
  } catch (error) {
    failures.push(error);
  }
  // Tear every started session down BEFORE removing the sandbox, so an in-flight session
  // can never rewrite the config after we stop watching it. A session whose start failed
  // was torn down already; this retries it if that failed. The real ~/.codex is untouched.
  for (const session of started) failures.push(...(await stop(session)));
  sandbox.dispose();
  if (failures.length > 1) throw new AggregateError(failures, "C-CODEX-14 and its cleanup failed");
  if (failures.length === 1) throw failures[0];
});
