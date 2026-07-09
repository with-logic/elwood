/**
 * Real Claude assistant_message provenance: committed transcript, not the hook.
 * Implements C-E2E-07 for C-CLAUDE-15.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { type ClaudeSession, startClaude } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

test("C-E2E-07 real Claude assistant_message comes from the committed transcript", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      permissionMode: "bypassPermissions",
      hookTimeoutMs: 10_000,
      autotrust: true,
    });
    const observed = observeSession(session);
    const acts = () => observed.activities as readonly ElwoodActivityEvent[];
    const marker = "ELWOOD_TX_OK";
    await session.sendMessage(`Reply exactly: ${marker}. Do not use tools.`);

    // The committed assistant turn must surface as an assistant_message whose
    // provenance is the transcript (source: "transcript"), NOT the Stop hook.
    await waitFor(
      () => (assistantFromTranscript(acts(), marker) ? true : undefined),
      "transcript-sourced Claude assistant_message",
    );
    const message = assistantFromTranscript(acts(), marker);
    assert.ok(message, "assistant_message present");
    assert.equal(message.source, "transcript");
    assert.ok(message.transcriptPath && message.transcriptPath.length > 0);

    // No assistant_message may originate from the hook path: that path can
    // carry un-sent ghost-text, which C-CLAUDE-15 forbids emitting as a message.
    const fromHook = acts().filter(
      (a) => a.agent === "claude" && a.kind === "assistant_message" && a.source === "hook",
    );
    assert.equal(fromHook.length, 0, "no assistant_message sourced from the hook");

    await session.kill();
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

function assistantFromTranscript(
  activities: readonly ElwoodActivityEvent[],
  marker: string,
): ElwoodActivityEvent | undefined {
  return activities.find(
    (a) =>
      a.agent === "claude" &&
      a.kind === "assistant_message" &&
      a.source === "transcript" &&
      (a.text ?? "").includes(marker),
  );
}
