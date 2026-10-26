/**
 * Removing a real Codex transcript after it existed is a read race that warns, not a
 * truncation read as an empty file. Implements PRD §5.7 and C-CODEX-23. A bogus `--model`
 * makes the turn that writes the transcript quota-free.
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import test from "node:test";
import { CodexSession, type ElwoodWarningEvent } from "../../src/index.ts";
import { codexLaunches, runCodexTest } from "./codex-ready.ts";
import {
  bogusCodexModel,
  codexAuthMissing,
  e2eTimeoutMs,
  type HookEvent,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

test("C-CODEX-23 a real Codex transcript removed after it existed emits transcript_read_error", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  // The transcript lives in this private CODEX_HOME, never the user's.
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const session = new CodexSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusCodexModel,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
  });
  const warnings: ElwoodWarningEvent[] = [];
  const records: string[] = [];
  let transcriptPath: string | undefined;
  session.on("warning", (warning) => warnings.push(warning));
  session.on("codex:transcript", (event) => records.push(event.summary.label));
  session.on("hook", (event: HookEvent) => {
    if (event.hook_event_name === "SessionStart")
      transcriptPath ??= event.transcript_path ?? undefined;
  });
  const readErrors = () => warnings.filter((warning) => warning.code === "transcript_read_error");
  const launches = codexLaunches();
  const scope = { sessions: () => [session], projects: [project], sandbox, launches };
  await runCodexTest(scope, async () => {
    const live = await launches.track(session.start());
    await live.waitForStatus((status) => status === "ready", e2eTimeoutMs);
    // Codex fires `SessionStart` lazily, with the first submission. The turn commits
    // records, so the watcher has read the file before it is removed.
    await live.sendMessage("Reply with exactly OK.");
    const path = await waitFor(() => transcriptPath, "SessionStart transcript_path");
    // Segment-aware containment: only a file inside this sandbox is ever unlinked.
    const inside = relative(realpathSync(sandbox.home), realpathSync(path));
    assert.ok(inside !== "" && !isAbsolute(inside) && inside.split(sep)[0] !== "..", path);
    await waitFor(() => (records.includes("task_complete") ? true : undefined), "task_complete");
    assert.ok(existsSync(path), "the transcript exists after the turn");
    assert.deepEqual(readErrors(), [], "no read error while the transcript exists");
    unlinkSync(path);
    const removed = await waitFor(
      () => (readErrors().length > 0 ? readErrors() : undefined),
      "transcript_read_error after removal",
      10_000,
    );
    assert.equal(
      removed[0]?.code === "transcript_read_error" && removed[0].lastErrorCode,
      "ENOENT",
    );
  });
});
