/**
 * Launches fresh, untrusted Claude folders with `autotrust` at once, the way Coal
 * Harbor starts agents. Concurrent launches load the machine, so Claude often takes
 * more than five seconds after its answered folder-trust dialog to paint the
 * composer. That boot is not a human decision: no launch may report `blocked` or a
 * blocking attention rule id while only the banner, or nothing, is on screen. Every
 * launch must show and answer the real prompt, or the run skips loudly.
 * Implements C-E2E-09 for C-ATTN-03 and C-TRUST-01 (§5.3, §5.4).
 */

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { type ClaudeSessionApi, type ElwoodSessionStatus, startClaude } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, skipIf, skipNow, skipReason, waitFor } from "./helpers.ts";
import { isTrustAnswer, recordLaunchEvidence } from "./trust-launch-evidence.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

// Sixteen at once pushed 10 of 16 real 2.1.310 boots past five seconds (2026-10-25);
// eight on a quiet machine booted in under four. No model turn is sent.
const launches = 16;
/** The once-per-generation transient the spec allows while the affirmative paints. */
const transientAttention = "workspace_trust";

type Launch = {
  readonly session: ClaudeSessionApi;
  readonly folder: string;
  readonly statuses: ElwoodSessionStatus[];
  readonly attention: string[];
  readyAt?: number;
};

test("C-E2E-09 concurrent autotrust launches never report an answered Claude trust gate as blocked", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async (t) => {
  const started: Launch[] = [];
  t.after(async () => {
    try {
      await Promise.all(started.map(({ session }) => cleanup(session)));
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  const evidence = recordLaunchEvidence();
  // Every launch settles before any failure is reported, so cleanup sees each session that
  // did start, including one that finished after a sibling's rejection.
  const outcomes = await Promise.allSettled(
    Array.from({ length: launches }, async () => {
      const project = makeProject("claude");
      const session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      const launch: Launch = {
        session,
        folder: realpathSync(project.cwd),
        statuses: [],
        attention: [],
      };
      started.push(launch);
      session.on("status", ({ status }) => {
        launch.statuses.push(status);
        if (status === "ready") launch.readyAt ??= Date.now();
      });
      session.on("activity", (event) => {
        if (event.kind === "attention") launch.attention.push(event.label);
      });
    }),
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed !== undefined) throw failed.reason;
  // One loop for every launch, so a failure leaves no sibling poll running after cleanup.
  // Settle on exit too, so an exit fails below with that launch's diagnostics.
  await waitFor(
    () =>
      started.every(({ session }) => session.status === "ready" || session.status === "exited")
        ? true
        : undefined,
    "every autotrust launch reaches ready",
    120_000,
  );
  const shown = started.map(({ folder }) => evidence.get(folder));
  if (shown.every((launch) => launch?.displayedAt === undefined)) {
    skipNow(
      t,
      "no launch displayed Claude's folder-trust prompt (auto-trusted or reworded); " +
        `first screen:\n${started[0]?.session.terminal.snapshot().text}`,
    );
    return;
  }
  const boots = started.map(({ readyAt }, index) => {
    const displayedAt = shown[index]?.displayedAt;
    return displayedAt === undefined || readyAt === undefined ? undefined : readyAt - displayedAt;
  });
  const ready = started.filter(({ session }) => session.status === "ready");
  t.diagnostic(
    `ready ${ready.length}/${launches}; prompt-to-ready ms: ${boots.join(", ")}; ` +
      `over 5 s: ${boots.filter((ms) => ms !== undefined && ms > 5_000).length}`,
  );
  for (const [index, { statuses, attention }] of started.entries()) {
    const launch = shown[index];
    assert.ok(launch?.displayedAt !== undefined, `launch ${index} displayed the trust prompt`);
    assert.ok(launch.writes.some(isTrustAnswer), `launch ${index} answered the trust prompt`);
    assert.ok(!statuses.includes("blocked"), `launch ${index} never reported blocked`);
    assert.deepEqual(
      attention.filter((label) => label !== transientAttention),
      [],
      `launch ${index} raised no blocking attention`,
    );
  }
  for (const [index, { session }] of started.entries()) {
    assert.equal(session.status, "ready", `launch ${index} cleared its gate instead of exiting`);
    assert.ok(!folderTrustScreenVisible(session.terminal.snapshot().text), "trust gate cleared");
  }
});
