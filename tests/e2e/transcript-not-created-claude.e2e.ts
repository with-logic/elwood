/**
 * A fresh real Claude session names its transcript in `SessionStart` before the first turn
 * writes the file; that wait is not a read race, so no `transcript_read_error` fires from
 * startup through the first turn. Implements PRD §5.7 and C-CLAUDE-24.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  ClaudeSession,
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  type HookEvent,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

// The watcher polls every 500 ms. Idling this long after ready lets several polls
// find the transcript missing before the first turn creates it.
const idleBeforeTurnMs = 3_000;

test("C-CLAUDE-24 a fresh real Claude session emits no transcript_read_error through its first turn", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  let transcriptPath: string | undefined;
  session.on("warning", (warning) => warnings.push(warning));
  session.on("activity", (activity) => activities.push(activity));
  session.on("hook", (event: HookEvent) => {
    if (event.hook_event_name === "SessionStart")
      transcriptPath ??= event.transcript_path ?? undefined;
  });
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", e2eTimeoutMs);
    const path = await waitFor(() => transcriptPath, "SessionStart transcript_path");
    const existedAtReady = existsSync(path);
    await new Promise((resolve) => setTimeout(resolve, idleBeforeTurnMs));
    const existedBeforeTurn = existsSync(path);
    await session.send("Reply with exactly OK and nothing else.");
    // The turn is over once its reply is read from the transcript the turn created.
    await waitFor(
      () => (activities.some((a) => a.kind === "assistant_message") ? true : undefined),
      "the first turn's transcript-sourced reply",
    );
    assert.ok(existsSync(path), "the first turn creates the transcript");
    const readErrors = warnings.filter((warning) => warning.code === "transcript_read_error");
    assert.deepEqual(
      readErrors,
      [],
      `transcript existed at ready: ${existedAtReady}; before the turn: ${existedBeforeTurn}`,
    );
  } finally {
    await cleanup(session.session);
  }
});
