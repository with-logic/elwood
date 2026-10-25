/**
 * A turn the real Claude CLI rejects fails instead of passing as a successful reply.
 * Implements PRD §5.8/§12A.2 and C-E2E-20 for C-API-59/C-CLI-28. A bogus `--model` is
 * refused before any model quota is consumed, so this runs on an out-of-quota account.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeSession, ElwoodError } from "../../src/index.ts";
import { invoke, parse } from "./cli-commands-helpers.ts";
import {
  e2eTimeoutMs,
  type HookEvent,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";

const bogusModel = "elwood-bogus-model";

type ErrorDocument = {
  readonly type: "result" | "error";
  readonly agent: "claude" | "codex" | null;
  readonly error?: { readonly code: string; readonly message: string };
};

test("C-E2E-20 elwood run reports a rejected real Claude turn as turn_failed with status 1", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const result = await invoke(
    [
      "--agent=claude",
      `--model=${bogusModel}`,
      `--state-dir=${project.stateDir}`,
      "--ephemeral",
      "--output=json",
      "--timeout=3m",
      "Reply with exactly OK.",
    ],
    project.cwd,
  );
  // Report both streams on any mismatch so an unrelated startup failure is diagnosable.
  const output = `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
  assert.equal(result.status, 1, output);
  const document = parse<ErrorDocument>(result, 1);
  assert.equal(document.type, "error", output);
  assert.equal(document.agent, "claude");
  assert.equal(document.error?.code, "turn_failed", output);
  assert.match(document.error?.message ?? "", /model_not_found/u);
});

test("C-E2E-20 ClaudeSession.send rejects a real Claude rejection with turn_failed", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusModel,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  const hooks: string[] = [];
  session.on("hook", (event: HookEvent) => hooks.push(event.hook_event_name));
  try {
    const outcome = await session.send("Reply with exactly OK.").then(
      (reply) => ({ reply }),
      (error: unknown) => ({ error }),
    );
    assert.ok("error" in outcome, `expected a rejection; send resolved ${JSON.stringify(outcome)}`);
    assert.ok(outcome.error instanceof ElwoodError, String(outcome.error));
    assert.equal(outcome.error.code, "turn_failed");
    assert.equal(outcome.error.details["info"], "model_not_found");
    // Claude reports the rejection with StopFailure INSTEAD of Stop.
    assert.ok(hooks.includes("StopFailure"), hooks.join(","));
    assert.ok(!hooks.includes("Stop"), hooks.join(","));
  } finally {
    await session.teardown().catch(() => session.kill());
  }
});
