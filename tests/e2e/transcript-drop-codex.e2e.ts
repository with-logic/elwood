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
  const drops: ElwoodWarningEvent[] = [];
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
      hooks,
    });
    // Warnings are live-only: collect drops off the `warning` event, not a snapshot.
    session.on("warning", (w) => {
      if (w.code === "transcript_records_dropped") drops.push(w);
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "codex ready", 60_000);
    // This Codex version fires its SessionStart hook on the FIRST turn, not at boot —
    // Elwood reaches readiness via its deadline path, and the rollout `transcript_path`
    // only reaches the caller's hook once the session actually does something. So run
    // one real turn first to make SessionStart fire and populate the injection target;
    // a genuinely absent-path CLI still fails loudly on the wait timeout below.
    await session.sendMessage("Reply exactly: ELWOOD_OK. Do not use tools.");
    await waitFor(
      () => (stops > 0 ? true : undefined),
      "first turn completes (fires SessionStart)",
    );
    await waitFor(
      () => (transcriptPath ? true : undefined),
      "Codex reported a rollout transcript_path to inject into",
      15_000,
    );
    assert.ok(transcriptPath, "Codex reported a rollout transcript_path to inject into");
    // Baseline the live drop count BEFORE injection, so the assertion can't be
    // satisfied by a pre-existing/unrelated drop — it must observe a NEW live drop
    // warning caused by the oversized record we inject.
    const baseDrops = drops.length;
    appendFileSync(transcriptPath, OVERSIZED);
    // The session must remain responsive: a second real turn completes rather than the
    // reader blocking the event loop on the huge unread delta.
    const stopsBefore = stops;
    await session.sendMessage("Reply exactly: ELWOOD_OK2. Do not use tools.");
    await waitFor(
      () => (stops > stopsBefore ? true : undefined),
      "second turn completes after oversized record",
    );
    assert.equal(session.status, "ready", "session settled to ready, not wedged");
    // The injected 1.1 MiB un-terminated record MUST surface as a NEW live drop
    // warning (poll ticks account it), and that warning MUST be content-free — never
    // the injected 'xxxxx' bytes. The CAUSE is legitimately either "oversized" (still
    // pending past the 1 MiB ceiling) or "unparseable" (a later Codex record appended
    // a newline, terminating the giant line so it parses-then-fails) — both are correct
    // bounded drops of the same injected record.
    const isInjectedDrop = (w: ElwoodWarningEvent) =>
      w.code === "transcript_records_dropped" &&
      w.transcriptPath === transcriptPath && // must be OUR transcript, not another observed one
      (w.cause === "oversized" || w.cause === "unparseable");
    await waitFor(
      () => (drops.slice(baseDrops).some(isInjectedDrop) ? true : undefined),
      "injected over-ceiling record surfaced as a new bounded live drop",
      20_000,
    );
    const drop = drops.slice(baseDrops).find(isInjectedDrop);
    assert.ok(drop, "a new transcript_records_dropped warning surfaced for the injected record");
    assert.ok(!JSON.stringify(drop).includes("xxxxx"), "drop warning is content-free");
  } finally {
    await cleanup(session);
  }
});
