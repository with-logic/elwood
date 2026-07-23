/**
 * Real-CLI verification that the bounded Codex transcript reader discards an
 * oversized record without OOM/hang and surfaces a content-free drop warning
 * (PRD §5.4, finding #13). Appends an over-length un-terminated record to the
 * REAL rollout transcript Codex is writing, then confirms the session stays
 * responsive and the drop is accounted, not read as hundreds of MiB.
 */

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import test from "node:test";
import { type CodexHookHandlers, type CodexSession, startCodex } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

// Larger than the cursor's 1 MiB pending ceiling, no trailing newline → discarded.
const OVERSIZED = `{"junk":"${"x".repeat(1_100_000)}"`;

test("C-E2E-03 real Codex bounds an oversized transcript record and stays usable", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSession | undefined;
  let transcriptPath: string | undefined;
  let stops = 0;
  const hooks: CodexHookHandlers = {
    SessionStart: (event) => {
      transcriptPath ??= event.transcript_path ?? undefined;
    },
    Stop: () => {
      stops += 1;
    },
  };
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
      hooks,
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "codex ready", 60_000);
    // Codex reports the rollout path via its hooks. This test's whole point is the
    // oversized-record → content-free drop, so we REQUIRE a path to inject into: if
    // the CLI version never reported one, fail loudly rather than passing green
    // without exercising the regression at all.
    assert.ok(transcriptPath, "Codex reported a rollout transcript_path to inject into");
    appendFileSync(transcriptPath, OVERSIZED);
    // The session must remain responsive: a real turn completes rather than the
    // reader blocking the event loop on the huge unread delta.
    await session.sendMessage("Reply exactly: ELWOOD_OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "turn completes after oversized record");
    assert.equal(session.status, "ready", "session settled to ready, not wedged");
    // The oversized record MUST surface as a drop warning (poll ticks account it),
    // and that warning MUST be content-free — never the injected 'xxxxx' bytes.
    await waitFor(
      () =>
        session?.warnings.some((w) => w.code === "transcript_records_dropped") ? true : undefined,
      "oversized record accounted as a drop warning",
      20_000,
    );
    const drop = session.warnings.find((w) => w.code === "transcript_records_dropped");
    assert.ok(drop, "a transcript_records_dropped warning was emitted");
    assert.ok(!JSON.stringify(drop).includes("xxxxx"), "drop warning is content-free");
  } finally {
    await cleanup(session);
  }
});
