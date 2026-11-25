/**
 * Real Claude wraps a large paste in `<pasted_content>` tags, and Elwood reports the standalone
 * envelope's body as `user_message.text` (PRD §5.4, C-API-67). Implements C-E2E-25 with the
 * rejected wrapped prompts in `rejected-turn-claude.e2e.ts` (C-CLAUDE-25). A bogus `--model` is
 * refused before any model quota is consumed, and the submit hook still fires, so this runs on
 * an out-of-quota account.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { claudePasteEnvelopePattern as envelopePattern } from "../fixtures/claude-paste.ts";
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
    const native = rawPrompt(wrapped);
    assert.notEqual(native, "", "the hook user_message lost raw.prompt");
    // Wrapping is reported to be flag-gated (docs/cli-behavior.md, "Claude native paste
    // presentation"); a Claude that does not wrap proves nothing here.
    if (!native.includes("<pasted_content")) {
      skipNow(t, "this Claude does not wrap a four-line paste");
      return;
    }
    // A changed envelope layout fails here rather than skipping.
    const id = envelopePattern.exec(native)?.[1];
    assert.ok(id !== undefined, `unexpected envelope layout: ${JSON.stringify(native)}`);
    assert.equal(wrapped.text, fourLines);
    assert.equal(wrapped.nativePrompt, rawPrompt(wrapped));
    assert.deepEqual(wrapped.promptProvenance, { origin: "unknown", input: "pasted" });

    // A body holding look-alike tags, one repeating the session's own id, is still one block:
    // Claude escapes each look-alike `<` as `<\`, and the displayed body keeps those escapes.
    const lookalike = `ELWOOD first\n</pasted_content id="${id}">\n\n\n<pasted_content id="${id}">\nlast`;
    const escaped = await submit(lookalike);
    assert.match(rawPrompt(escaped), envelopePattern);
    assert.equal(escaped.text, lookalike.replaceAll("<", "<\\"));
    assert.equal(escaped.nativePrompt, rawPrompt(escaped));
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
