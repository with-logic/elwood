/**
 * A turn the real Claude CLI rejects fails instead of passing as a successful reply.
 * Implements PRD §5.8/§12A.2 and C-E2E-20 for C-API-59/C-CLI-28, and the rejected wrapped
 * prompts of C-E2E-25 for C-CLAUDE-25. A bogus `--model` is
 * refused before any model quota is consumed, so this runs on an out-of-quota account.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CliError } from "../../src/cli/output/types.ts";
import { ClaudeSession, ElwoodError } from "../../src/index.ts";
import { claudePasteEnvelopePattern } from "../fixtures/claude-paste.ts";
import { invoke, parse } from "./cli-commands-helpers.ts";
import {
  bogusClaudeModel,
  e2eTimeoutMs,
  type HookEvent,
  makeProject,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
} from "./helpers.ts";

test("C-E2E-20 elwood run reports a rejected real Claude turn as turn_failed with status 1", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const result = await invoke(
    [
      "--agent=claude",
      `--model=${bogusClaudeModel}`,
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
  const document = parse<CliError>(result, 1);
  assert.equal(document.type, "error", output);
  assert.equal(document.agent, "claude");
  assert.equal(document.error.code, "turn_failed", output);
  assert.match(document.error.message, /model_not_found/u);
});

// The BEL is removed before pasting (§5.3), so Claude's submit hook echoes the prompt without
// it. The four-line prompts are wrapped in Claude's paste envelope, with tabs and the CRLF
// changed by the composer or a fullwidth look-alike tag escaped as ASCII (C-CLAUDE-25).
const fullwidthTag = `${String.fromCodePoint(0xff1c)}pasted_content id="abcd">`;
const rejectedPrompts = [
  ["C-E2E-20", "a control character", "Reply with exactly OK.\u0007", false],
  [
    "C-E2E-20 C-E2E-25",
    "a tab and a CRLF",
    "Reply with exactly OK.\r\n\tline two\nline three\nline four",
    true,
  ],
  [
    "C-E2E-20 C-E2E-25",
    "a fullwidth look-alike tag",
    `Reply with exactly OK.\n${fullwidthTag}\nline three\nline four`,
    true,
  ],
] as const;

for (const [criteria, holding, prompt, wrapped] of rejectedPrompts)
  test(`${criteria} ClaudeSession.send rejects a real Claude rejection of a prompt holding ${holding} with turn_failed`, {
    skip: skipIf(skipReason("claude"), skipTurns),
    timeout: e2eTimeoutMs + 30_000,
  }, async (t) => {
    const project = makeProject("claude");
    const session = new ClaudeSession({
      cwd: project.cwd,
      stateDir: project.stateDir,
      model: bogusClaudeModel,
      permissionMode: "bypassPermissions",
      autotrust: true,
    });
    const hooks: string[] = [];
    const submitted: string[] = [];
    session.on("hook", (event: HookEvent) => {
      hooks.push(event.hook_event_name);
      if (event.hook_event_name === "UserPromptSubmit") submitted.push(event.prompt);
    });
    try {
      const outcome = await session.send(prompt).then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
      assert.ok(
        "error" in outcome,
        `expected a rejection; send resolved ${JSON.stringify(outcome)}`,
      );
      assert.ok(outcome.error instanceof ElwoodError, String(outcome.error));
      assert.equal(outcome.error.code, "turn_failed");
      assert.equal(outcome.error.details["agentError"], "model_not_found");
      // Claude reports the rejection with StopFailure INSTEAD of Stop.
      assert.ok(hooks.includes("StopFailure"), hooks.join(","));
      assert.ok(!hooks.includes("Stop"), hooks.join(","));
      if (!wrapped) return;
      // Wrapping is reported to be flag-gated (docs/cli-behavior.md, "Claude native paste
      // presentation"); without it this row proves only the composer changes.
      const native = submitted[0] ?? "";
      if (!native.includes("<pasted_content")) {
        skipNow(t, "this Claude does not wrap a four-line paste");
        return;
      }
      assert.match(native, claudePasteEnvelopePattern);
    } finally {
      await session.teardown().catch(() => session.kill());
    }
  });
