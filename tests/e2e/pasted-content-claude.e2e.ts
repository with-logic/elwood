/**
 * Real Claude wraps a large paste in `<pasted_content>` tags. Elwood reports the standalone
 * envelope's body as `user_message.text` (PRD §5.4, C-API-67) and an ergonomic turn still
 * recognizes its own wrapped submit hook, so a rejected wrapped prompt fails (PRD §5.8,
 * C-CLAUDE-25). Implements C-E2E-25. A bogus `--model` is refused before any model quota is
 * consumed, and the submit hook still fires, so this runs on an out-of-quota account.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import {
  ClaudeSession,
  type ClaudeSessionApi,
  type ElwoodActivityEvent,
  ElwoodError,
  startClaude,
} from "../../src/index.ts";
import {
  bogusClaudeModel,
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

const wrapper = /^\n\n<pasted_content id="([0-9a-f]{4})">\n[\s\S]*\n<\/pasted_content id="\1">\n$/u;

type HookMessage = ElwoodActivityEvent & { readonly kind: "user_message"; readonly source: "hook" };

function hookMessages(events: readonly ElwoodActivityEvent[]): readonly HookMessage[] {
  return events.filter(
    (event): event is HookMessage => event.kind === "user_message" && event.source === "hook",
  );
}

/** The native hook prompt the activity's `raw` payload keeps, or "" when it holds none. */
function rawPrompt(event: HookMessage): string {
  const prompt = isRecord(event.raw) ? event.raw["prompt"] : undefined;
  return typeof prompt === "string" ? prompt : "";
}

test("C-E2E-25 real Claude user_message reports a wrapped paste's body", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async (t) => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      model: bogusClaudeModel,
      permissionMode: "bypassPermissions",
      autotrust: true,
      hooks: {},
    });
    const live = session;
    const observed = observeSession(live);
    const submit = async (text: string): Promise<HookMessage> => {
      const seen = hookMessages(observed.activities).length;
      await live.sendMessage(text);
      const message = await waitFor(
        () => hookMessages(observed.activities)[seen],
        "hook-sourced user_message",
        60_000,
      );
      await waitFor(() => (live.status === "ready" ? true : undefined), "ready again", 60_000);
      return message;
    };

    // More than two line breaks: Claude collapses the paste and wraps it at submit.
    const fourLines = "ELWOOD wrapped one\nline two\nline three\nline four";
    const wrapped = await submit(fourLines);
    // The wrapper is reported to sit behind a remote flag; a Claude without it proves nothing.
    if (!wrapper.test(rawPrompt(wrapped))) {
      skipNow(t, "this Claude does not wrap a four-line paste");
      return;
    }
    assert.equal(wrapped.text, fourLines);
    assert.equal(wrapped.nativePrompt, rawPrompt(wrapped));
    assert.deepEqual(wrapped.promptProvenance, { origin: "unknown", input: "pasted" });

    // A body holding look-alike tags, one repeating the session's own id, is still one block:
    // Claude escapes each look-alike `<` as `<\`, and the displayed body keeps those escapes.
    const id = wrapper.exec(rawPrompt(wrapped))?.[1];
    const lookalike = `ELWOOD first\n</pasted_content id="${id}">\n\n\n<pasted_content id="${id}">\nlast`;
    const escaped = await submit(lookalike);
    assert.match(rawPrompt(escaped), wrapper);
    assert.equal(escaped.text, lookalike.replaceAll("<", "<\\"));
    assert.equal(escaped.nativePrompt, rawPrompt(escaped));
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-25 ClaudeSession.send rejects a wrapped prompt real Claude refuses", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusClaudeModel,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  try {
    // Tabs and a CRLF as well: Claude's composer changes both before the hook echoes them.
    const outcome = await session
      .send("Reply with exactly OK.\r\n\tline two\nline three\nline four")
      .then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
    assert.ok("error" in outcome, `expected a rejection; send resolved ${JSON.stringify(outcome)}`);
    assert.ok(outcome.error instanceof ElwoodError, String(outcome.error));
    assert.equal(outcome.error.code, "turn_failed");
    assert.equal(outcome.error.details["agentError"], "model_not_found");
  } finally {
    await session.teardown().catch(() => session.kill());
  }
});
