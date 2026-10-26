/**
 * A turn the real Codex CLI rejects fails instead of hanging or passing as a reply.
 * Implements PRD §5.8/§12A.2 and C-E2E-21 for C-API-60/C-CLI-28. Codex fires no `Stop` for
 * a rejected turn, so its failed transcript `task_complete` is the only evidence. A bogus
 * `--model` is refused before any model quota is consumed, so this needs no model quota.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CliError } from "../../src/cli/output/types.ts";
import { CodexSession, ElwoodError } from "../../src/index.ts";
import { invoke, parse } from "./cli-commands-helpers.ts";
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
} from "./helpers.ts";

const config = "check_for_update_on_startup = false\n";

test("C-E2E-21 elwood run reports a rejected real Codex turn as turn_failed with status 1", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, config);
  try {
    const result = await invoke(
      [
        "--agent=codex",
        `--model=${bogusCodexModel}`,
        `--state-dir=${project.stateDir}`,
        "--ephemeral",
        "--output=json",
        "--timeout=2m",
        "Reply with exactly OK.",
      ],
      project.cwd,
    );
    // Report both streams on any mismatch so an unrelated startup failure is diagnosable.
    const output = `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
    assert.equal(result.status, 1, output);
    const document = parse<CliError>(result, 1);
    assert.equal(document.type, "error", output);
    assert.equal(document.agent, "codex");
    assert.equal(document.error.code, "turn_failed", output);
    assert.match(document.error.message, /model_not_found/u);
  } finally {
    sandbox.dispose();
  }
});

test("C-E2E-21 CodexSession.send rejects a real Codex rejection with turn_failed", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, config);
  const session = new CodexSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusCodexModel,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
  });
  const hooks: string[] = [];
  session.on("hook", (event: HookEvent) => hooks.push(event.hook_event_name));
  const settle = (prompt: string) =>
    session.send(prompt).then(
      (reply) => ({ reply }),
      (error: unknown) => ({ error }),
    );
  try {
    for (const prompt of ["Reply with exactly OK.", "Reply with exactly AGAIN."]) {
      // The second turn proves the first released the session at its real boundary.
      const outcome = await settle(prompt);
      assert.ok(
        "error" in outcome,
        `expected a rejection; send resolved ${JSON.stringify(outcome)}`,
      );
      assert.ok(outcome.error instanceof ElwoodError, String(outcome.error));
      assert.equal(outcome.error.code, "turn_failed", outcome.error.message);
      assert.match(outcome.error.message, /model_not_found/u);
      assert.equal(typeof outcome.error.details["agentError"], "string");
    }
    // Codex accepted both submissions and fired no `Stop` for either.
    assert.equal(hooks.filter((name) => name === "UserPromptSubmit").length, 2, hooks.join(","));
    assert.ok(!hooks.includes("Stop"), hooks.join(","));
  } finally {
    await session.teardown().catch(() => session.kill());
    sandbox.dispose();
  }
});
