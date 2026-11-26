/**
 * A real Codex started on a home with no login opens on its sign-in screen, which Elwood
 * does not recognize. From the readiness deadline the session is `blocked` on it with its
 * text, and nothing is written to it. Implements C-E2E-29 (PRD §5.4, C-ATTN-09).
 *
 * The test never moves past the first sign-in page: Codex's API-key page prefills the key
 * from the environment, which the launch shell's startup files can export, and would show
 * it on screen. Assertion messages therefore never print the screen.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, observeSession, skipIf, skipReason, waitFor } from "./helpers.ts";
import { recordPty } from "./pty-record.ts";
import { codexAuthMissing, sandboxedCodexHome } from "./scratch.ts";
import { isTerminalProtocolReply } from "./terminal-protocol-reply.ts";

/** The deadline is 10 s after the first frame; the rest is slack for a loaded host. */
const reportWithinMs = 20_000;

test("C-E2E-29 Codex's sign-in screen blocks the session, and nothing is written to it", {
  skip: skipIf(skipReason("codex") ?? codexAuthMissing()),
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  // The sandbox starts with the user's login; without it Codex asks how to sign in.
  rmSync(join(sandbox.home, "auth.json"));
  const record = recordPty();
  let session: CodexSessionApi | undefined;
  try {
    session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const active = session;
    const observed = observeSession(active);
    let firstFrameAt: number | undefined;
    let blockedAt: number | undefined;
    active.on("terminal:data", () => {
      firstFrameAt ??= Date.now();
    });
    active.on("activity", (event) => {
      if (event.kind === "attention" && event.label === "codex-unrecognized-startup")
        blockedAt ??= Date.now();
    });
    const sent = active.sendMessage("Reply with the single word PONG.");
    const settled = { done: false };
    void sent.then(
      () => {
        settled.done = true;
      },
      () => {},
    );
    const report = await waitFor(
      () => observed.activities.find((event) => event.kind === "unrecognized_startup"),
      "the unrecognized startup report",
      60_000,
    );
    assert.equal(active.status, "blocked");
    assert.equal(report.label, "initial_ready_deadline");
    assert.ok(report.text.includes("Sign in with ChatGPT"), "the report holds the sign-in screen");
    const startedAt = firstFrameAt ?? Date.now();
    assert.ok(blockedAt !== undefined && blockedAt - startedAt <= reportWithinMs, "blocked late");
    // A second later: still blocked on the same screen, the message still held.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(active.status, "blocked");
    assert.ok(active.terminal.snapshot().text.includes("Sign in with ChatGPT"));
    assert.equal(settled.done, false);
    const input = record.writes.filter(({ data }) => !isTerminalProtocolReply(data));
    assert.equal(input.length, 0, "nothing was written to the sign-in screen");
    const reports = observed.activities.filter((event) => event.kind === "unrecognized_startup");
    assert.equal(reports.length, 1, "the animated screen was reported once");
  } finally {
    await cleanup(session);
    resetRuntimeSeamsForTests();
    sandbox.dispose();
  }
});
