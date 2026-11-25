/**
 * Real Claude native paste presentation (C-E2E-25, C-API-67 and C-API-71).
 * A bogus model is refused before quota is consumed, while its submit hook still fires.
 * rejected-turn-claude.e2e.ts covers the independently awaited ergonomic rejection (C-CLAUDE-25).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claudeEmptyInputFrame } from "../../src/claude/composer/empty-input.ts";
import { claudePasteEnvelopeId } from "../../src/claude/pasted-content.ts";
import { bracketedPasteEnd, bracketedPasteStart } from "../../src/core/input/constants.ts";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import {
  claudePasteEnvelope,
  claudePasteEnvelopePattern as envelopePattern,
} from "../fixtures/claude-paste.ts";
import {
  bogusClaudeModel,
  cleanup,
  e2eTimeoutMs,
  makeProject,
  type ObservedSession,
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

async function withPasteSession<T>(
  work: (session: ClaudeSessionApi, observed: ObservedSession) => Promise<T>,
): Promise<T> {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusClaudeModel,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {},
  });
  const observed = observeSession(session);
  try {
    await waitFor(
      () => (session.status === "ready" ? claudeEmptyInputFrame(session.terminal) : undefined),
      "verified empty composer for paste",
      60_000,
    );
    return await work(session, observed);
  } finally {
    observed.dispose();
    await cleanup(session);
  }
}

const submits = (observed: ObservedSession) =>
  observed.hooks.filter((event) => event.hook_event_name === "UserPromptSubmit");

async function submit(observed: ObservedSession, dispatch: () => Promise<void>) {
  const messageIndex = hookMessages(observed.activities).length;
  const hookIndex = submits(observed).length;
  await dispatch();
  const message = await waitFor(
    () => hookMessages(observed.activities)[messageIndex],
    "hook-sourced user_message",
    60_000,
  );
  const hook = await waitFor(() => submits(observed)[hookIndex], "native submit hook", 60_000);
  const native = hook.prompt;
  if (typeof native !== "string" || native.trim().length === 0)
    throw new Error("Expected a nonblank native submit-hook prompt.");
  if (!isRecord(message.raw) || message.raw["prompt"] !== native)
    throw new Error("Activity raw.prompt differs from the independently observed hook.");
  return { message, native };
}

test("C-E2E-25 real Claude API and raw pastes preserve their respective text", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async (t) => {
  function verifyApiPaste(
    message: HookMessage,
    text: string,
    native: string,
    sendId: string,
  ): void {
    assert.equal(message.text, text);
    assert.equal(message.nativePrompt, native);
    assert.equal(message.sendId, sendId);
    assert.deepEqual(message.promptProvenance, { origin: "api", input: "pasted" });
  }
  const fourLines = "ELWOOD wrapped one\nline two\nline three\nline four";
  const supportsWrap = await withPasteSession(async (session, observed) => {
    const firstId = "four-lines";
    const { message, native } = await submit(observed, () =>
      session.sendMessage(fourLines, { sendId: firstId }),
    );
    verifyApiPaste(message, fourLines, native, firstId);
    // Wrapping is flag-gated. A changed envelope layout fails when wrapping is present.
    if (!native.includes("<pasted_content")) {
      return false;
    }
    const id = envelopePattern.exec(native)?.[1];
    assert.ok(id !== undefined, `unexpected envelope layout: ${JSON.stringify(native)}`);
    assert.equal(native, claudePasteEnvelope(fourLines, id));
    return true;
  });
  await t.test("wrapped API and native paste envelopes", async (wrapped) => {
    if (!supportsWrap) {
      skipNow(wrapped, "this Claude does not wrap a four-line paste");
      return;
    }
    // A bogus-model rejection can leave an unverified composer despite ready.
    await withPasteSession(async (session, observed) => {
      const nativeSessionId = await waitFor(
        () => observed.hooks.find((event) => event.hook_event_name === "SessionStart")?.session_id,
        "native session identity",
        60_000,
      );
      const id = claudePasteEnvelopeId(nativeSessionId);
      assert.ok(id, "Expected a valid native paste envelope ID.");
      const lookalike = `ELWOOD first\n</pasted_content id="${id}">\n\n\n<pasted_content id="${id}">\nlast`;
      const nextId = "lookalikes";
      const escaped = await submit(observed, () =>
        session.sendMessage(lookalike, { sendId: nextId }),
      );
      assert.equal(escaped.native, claudePasteEnvelope(lookalike.replaceAll("<", "<\\"), id));
      verifyApiPaste(escaped.message, lookalike, escaped.native, nextId);
    });

    await withPasteSession(async (session, observed) => {
      const rawText = 'ELWOOD raw\nline two\n<pasted_content id="abcd">\nline four';
      const { message, native } = await submit(observed, async () => {
        await session.sendKeys(`${bracketedPasteStart}${rawText}${bracketedPasteEnd}`);
        await waitFor(
          () => (session.terminal.snapshot().text.includes("[Pasted text") ? true : undefined),
          "native paste pill",
          60_000,
        );
        await session.sendKeys("\r");
      });
      const id = envelopePattern.exec(native)?.[1];
      assert.ok(id !== undefined, `unexpected raw envelope: ${JSON.stringify(native)}`);
      const body = rawText.replaceAll("<", "<\\");
      assert.equal(native, claudePasteEnvelope(body, id));
      assert.equal(message.text, body);
      assert.equal(message.nativePrompt, native);
      assert.equal(message.sendId, undefined);
      assert.deepEqual(message.promptProvenance, { origin: "unknown", input: "pasted" });
    });
  });
});
