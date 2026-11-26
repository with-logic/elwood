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
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, skipIf, skipReason } from "./helpers.ts";
import { recordPty } from "./pty-record.ts";
import { sandboxedCodexHome } from "./scratch.ts";
import { awaitStartupBlock } from "./unrecognized-startup.ts";

test("C-E2E-29 Codex's sign-in screen blocks the session, and nothing is written to it", {
  skip: skipIf(skipReason("codex")),
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  // Without a login Codex asks how to sign in.
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n", {
    login: false,
  });
  const record = recordPty();
  let session: CodexSessionApi | undefined;
  try {
    session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
    const active = session;
    const sent = active.sendMessage("Reply with the single word PONG.");
    const { observed, outcome, input } = await awaitStartupBlock(active, record, sent, {
      label: "codex-unrecognized-startup",
      screen: "Sign in with ChatGPT",
    });
    // A second later: still blocked on the same screen, the message still held.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(active.status, "blocked");
    assert.ok(active.terminal.snapshot().text.includes("Sign in with ChatGPT"));
    assert.equal(outcome.current, "pending", "the queued message is still held");
    assert.deepEqual(input(), [], "nothing was written to the sign-in screen");
    const reports = observed.activities.filter((event) => event.kind === "unrecognized_startup");
    assert.equal(reports.length, 1, "the animated screen was reported once");
  } finally {
    await cleanup(session);
    resetRuntimeSeamsForTests();
    sandbox.dispose();
  }
});
