/**
 * Launches fresh, untrusted Claude folders with `autotrust` at once, the way Coal
 * Harbor starts agents. Concurrent launches load the machine, so Claude often takes
 * more than five seconds after its answered folder-trust dialog to paint the
 * composer. That boot is not a human decision: no launch may report `blocked` or a
 * blocking attention rule id while only the banner, or nothing, is on screen.
 * Implements C-E2E-09 for C-ATTN-03 and C-TRUST-01 (§5.3, §5.4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

// Sixteen at once pushed 10 of 16 real 2.1.310 boots past five seconds (2026-10-25);
// eight on a quiet machine booted in under four. No model turn is sent.
const launches = 16;
/** The once-per-generation transient the spec allows while the affirmative paints. */
const transientAttention = "workspace_trust";

type Launch = {
  readonly session: ClaudeSessionApi;
  readonly statuses: string[];
  readonly attention: string[];
  dialogAt?: number;
  readyAt?: number;
};

test("C-E2E-09 concurrent autotrust launches never report an answered Claude trust gate as blocked", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async (t) => {
  const started: Launch[] = [];
  t.after(() => Promise.all(started.map(({ session }) => cleanup(session))));
  await Promise.all(
    Array.from({ length: launches }, async () => {
      const project = makeProject("claude");
      const session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      const launch: Launch = { session, statuses: [], attention: [] };
      started.push(launch);
      session.on("terminal:data", () => {
        if (
          launch.dialogAt === undefined &&
          folderTrustScreenVisible(session.terminal.snapshot().text)
        )
          launch.dialogAt = Date.now();
      });
      session.on("status", ({ status }) => {
        launch.statuses.push(status);
        if (status === "ready") launch.readyAt ??= Date.now();
      });
      session.on("activity", (event) => {
        if (event.kind === "attention") launch.attention.push(event.label);
      });
    }),
  );
  await Promise.all(
    started.map(({ session }, index) =>
      waitFor(
        // Settle on exit too, so an exit fails below with this launch's diagnostics.
        () => (session.status === "ready" || session.status === "exited" ? true : undefined),
        `autotrust launch ${index} reaches ready`,
        120_000,
      ),
    ),
  );
  const boots = started.map(({ dialogAt, readyAt }) =>
    dialogAt === undefined || readyAt === undefined ? undefined : readyAt - dialogAt,
  );
  const ready = started.filter(({ session }) => session.status === "ready");
  t.diagnostic(
    `ready ${ready.length}/${launches}; dialog-to-ready ms: ${boots.join(", ")}; ` +
      `over 5 s: ${boots.filter((ms) => ms !== undefined && ms > 5_000).length}`,
  );
  for (const [index, { statuses, attention }] of started.entries()) {
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
