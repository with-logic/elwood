/**
 * Real-CLI verification that a RESUMED Codex session reaches readiness promptly
 * on the first composer marker instead of waiting out the ~10s readiness deadline
 * (PRD §5.3, C-API-28). The Codex CLI does not re-fire `SessionStart` on resume, so
 * before this change every resume paid the full deadline; now it is composer-driven.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSession, resumeCodex, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

test("C-API-28 real Codex resume reaches ready promptly (composer, not the 10s deadline)", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  const opts = {
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    autotrust: true,
    hooks: {},
  };
  let first: CodexSession | undefined;
  let resumed: CodexSession | undefined;
  try {
    first = await startCodex(opts);
    await waitFor(() => (first?.status === "ready" ? true : undefined), "first ready", 60_000);
    // One real turn so Codex persists a resumable conversation id.
    await first.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(
      () => (first?.status === "ready" ? true : undefined),
      "first turn settled",
      60_000,
    );
    const id = first.elwoodSessionId;
    await first.stop();

    const startedAt = Date.now();
    resumed = await resumeCodex({ ...opts, elwoodSessionId: id });
    await waitFor(() => (resumed?.status === "ready" ? true : undefined), "resumed ready", 30_000);
    const elapsed = Date.now() - startedAt;
    // The 10s deadline was the old floor; the composer path reaches ready well under
    // it. Allow generous headroom for CI while still proving we don't pay the deadline.
    assert.ok(
      elapsed < 8_000,
      `resumed reached ready in ${elapsed}ms (must beat the ~10s deadline)`,
    );
  } finally {
    await cleanup(resumed);
    await cleanup(first);
  }
});
