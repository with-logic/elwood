/**
 * Launches several fresh, untrusted Claude folders with `autotrust` at once, the way
 * Coal Harbor starts agents, and requires every one to clear the REAL folder-trust gate
 * and reach `ready`. Concurrent launches load the machine, which is when Claude's trust
 * dialog resets its selection to "No, exit" as its input guard settles; an Enter that
 * travelled without its own absolute selection then exits the CLI with code 1.
 * Implements C-E2E-09 for C-CLAUDE-10 and C-TRUST-01 (§5.1, §5.4).
 */

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { isAbsoluteAnswer, isTrustInput, recordLaunchEvidence } from "./trust-launch-evidence.ts";
import { folderTrustScreenVisible } from "./trust-screens.ts";

const launches = 5;

test("C-E2E-09 concurrent fresh-folder autotrust launches all clear the REAL Claude trust gate", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async (t) => {
  const sessions: ClaudeSessionApi[] = [];
  const exits: number[] = [];
  t.after(async () => {
    try {
      await Promise.all(sessions.map((session) => cleanup(session)));
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  // Delegate to the real PTY; record every physical write each session makes.
  const evidence = recordLaunchEvidence();
  const folders = Array.from({ length: launches }, () => makeProject("claude"));
  // Every launch settles before any failure is reported, so cleanup sees each session that
  // did start, including one that finished after a sibling's rejection.
  const outcomes = await Promise.allSettled(
    folders.map(async (project) => {
      const session = await startClaude({
        cwd: project.cwd,
        stateDir: project.stateDir,
        autotrust: true,
      });
      sessions.push(session);
      session.on("activity", (event) => {
        if (event.kind === "terminal_exit" && event.exitCode !== undefined)
          exits.push(event.exitCode);
      });
      return session;
    }),
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed !== undefined) throw failed.reason;
  // One loop for every launch, so a failure leaves no sibling poll running after cleanup.
  await waitFor(
    () => {
      const exited = sessions.findIndex((session) => session.status === "exited");
      if (exited >= 0) throw new Error(`launch ${exited} exited at its gate`);
      const cleared = sessions.every(
        (session) =>
          session.status === "ready" && !folderTrustScreenVisible(session.terminal.snapshot().text),
      );
      return cleared ? true : undefined;
    },
    "every autotrust launch clears the folder-trust gate and reaches ready",
    120_000,
  );
  assert.deepEqual(exits, [], "no launch exited at its trust gate");
  for (const project of folders) {
    const answers = (evidence.get(realpathSync(project.cwd))?.writes ?? []).filter(isTrustInput);
    assert.ok(answers.length > 0, `the launch in ${project.cwd} answered its own trust gate`);
    for (const input of answers) {
      // A relative arrow or bare Enter is decided from a frame the CLI may already have
      // reset; every trust write carries its own absolute selection.
      assert.ok(isAbsoluteAnswer(input), `trust write ${JSON.stringify(input)} is absolute`);
    }
  }
});
