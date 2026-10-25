/**
 * Real-CLI proof that stopping a Codex session from the `ready` its `Stop` hook produces
 * leaves the turn committed (PRD §5.7, C-LIFE-13). Codex records the turn's
 * `task_complete` only after that hook returns. Signaled in the gap, Codex 0.164.0 exits
 * without it, and the resumed conversation ends in "Conversation interrupted".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { startReadyCodex, stopCodex } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

// One short turn on a small model: the test needs a committed turn, not a good answer.
const CODEX_CONFIG = 'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\n';
const READY_MS = 60_000;
const TURN_MS = 60_000;

/** The `payload.type` and `payload.turn_id` of every rollout record, in order. */
function rolloutRecords(path: string): readonly { payloadType: unknown; turnId: unknown }[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const payload: unknown = JSON.parse(line)?.payload;
      const fields = typeof payload === "object" && payload !== null ? payload : {};
      return {
        payloadType: "type" in fields ? fields.type : undefined,
        turnId: "turn_id" in fields ? fields.turn_id : undefined,
      };
    });
}

test("C-LIFE-13 real Codex: stop() at the Stop-hook ready leaves the turn committed", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: READY_MS + TURN_MS + 30_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
  let started: CodexSessionApi | undefined;
  let failure: unknown;
  try {
    const session = await startReadyCodex(project, {
      readyTimeoutMs: READY_MS,
      onStarted: (launched) => {
        started = launched;
      },
    });
    let stopHook: { transcriptPath: string | null | undefined; turnId: string } | undefined;
    session.on("hook", (event) => {
      if (event.hook_event_name === "Stop")
        stopHook = { transcriptPath: event.transcript_path, turnId: event.turn_id };
    });
    let stopping: Promise<void> | undefined;
    const statuses: string[] = [];
    // A host closing a finished session: stop in the same tick as the hook's `ready`.
    session.on("status", (event) => {
      statuses.push(`${event.status}${stopHook ? "+Stop" : ""}`);
      if (event.status === "ready" && stopHook) stopping ??= session.stop();
    });
    await session.sendMessage("Reply exactly: OK. Do not use tools.");
    try {
      await waitFor(() => (stopping ? true : undefined), "a stop at the Stop-hook ready", TURN_MS);
    } catch (error) {
      const screen = session.terminal.snapshot().text.trimEnd().split("\n").slice(-12);
      throw new Error(`statuses ${statuses.join(",")}; screen:\n${screen.join("\n")}`, {
        cause: error,
      });
    }
    await stopping;
    assert.equal(session.status, "stopped");
    const { transcriptPath, turnId } = stopHook ?? { transcriptPath: undefined, turnId: "" };
    assert.ok(transcriptPath, "the Stop hook carried the rollout path");
    const records = rolloutRecords(transcriptPath);
    const tail = records.slice(-4).map((record) => String(record.payloadType));
    assert.ok(
      records.some((record) => record.payloadType === "task_complete" && record.turnId === turnId),
      `rollout has no task_complete for ${turnId}; it ends ${tail.join(",")}`,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const shutdownFailures = started ? await stopCodex(started) : [];
    if (shutdownFailures.length === 0) sandbox.dispose();
    else {
      const errors = failure === undefined ? shutdownFailures : [failure, ...shutdownFailures];
      // biome-ignore lint/correctness/noUnsafeFinally: a process that outlives the test must fail it.
      throw new AggregateError(errors, "Codex session did not shut down");
    }
  }
});
