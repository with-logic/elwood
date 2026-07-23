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
import {
  type CodexHookHandlers,
  type CodexSession,
  type ElwoodWarningEvent,
  startCodex,
} from "../../src/index.ts";
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
    // Baseline the drop accounting BEFORE injection, so the assertion can't be
    // satisfied by a pre-existing/unrelated drop (e.g. a parse issue or a teardown
    // backlog from a different cause) — it must observe the oversized delta we cause.
    const dropBefore = (w: ElwoodWarningEvent) => w.code === "transcript_records_dropped";
    const baseline = session.warnings.filter(dropBefore).at(-1);
    const baseBytes = baseline?.code === "transcript_records_dropped" ? baseline.droppedBytes : 0;
    const baseCount = baseline?.code === "transcript_records_dropped" ? baseline.droppedCount : 0;
    appendFileSync(transcriptPath, OVERSIZED);
    // The session must remain responsive: a real turn completes rather than the
    // reader blocking the event loop on the huge unread delta.
    await session.sendMessage("Reply exactly: ELWOOD_OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "turn completes after oversized record");
    assert.equal(session.status, "ready", "session settled to ready, not wedged");
    // The oversized record MUST surface as a NEW oversized-cause drop warning whose
    // running totals grew past the baseline (poll ticks account it), and that warning
    // MUST be content-free — never the injected 'xxxxx' bytes.
    const isOversizedDelta = (w: ElwoodWarningEvent) =>
      w.code === "transcript_records_dropped" &&
      w.cause === "oversized" &&
      w.droppedBytes > baseBytes &&
      w.droppedCount > baseCount;
    await waitFor(
      () => (session?.warnings.some(isOversizedDelta) ? true : undefined),
      "oversized record accounted as a new oversized drop warning",
      20_000,
    );
    const drop = session.warnings.find(isOversizedDelta);
    assert.ok(drop, "a new oversized transcript_records_dropped warning was emitted");
    assert.ok(!JSON.stringify(drop).includes("xxxxx"), "drop warning is content-free");
  } finally {
    await cleanup(session);
  }
});
