/**
 * Real-CLI e2e for the ergonomic `send`/`stream` facade (PRD §5.8).
 * Implements C-E2E-14 (send collects a turn's assistant text and multi-turn context is
 * retained) and C-E2E-15 (stream yields simplified typed events and ends on settle).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeSession,
  type ClaudeSessionOptions,
  CodexSession,
  type CodexSessionOptions,
  type TurnEvent,
} from "../../src/index.ts";
import { e2eTimeoutMs, makeProject, skipReason, turnsEnabled } from "./helpers.ts";

const skipTurns = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

test("C-E2E-14 ClaudeSession.send collects assistant text and retains context", {
  skip: skipReason("claude") ?? skipTurns,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  const options: ClaudeSessionOptions = {
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  };
  const session = new ClaudeSession(options);
  try {
    assert.equal(session.session, undefined, "not started before the first send");
    const first = await session.send(
      "My favorite animal is the axolotl. Reply with just one short sentence acknowledging that.",
    );
    assert.ok(first.trim().length > 0, "first send returns non-empty assistant text");
    assert.ok(session.session, "the underlying session started lazily on the first send");
    const second = await session.send(
      "What did I say my favorite animal was? Answer with just the animal name.",
    );
    assert.match(second.toLowerCase(), /axolotl/, "the second turn retains first-turn context");
  } finally {
    await session.close();
  }
});

test("C-E2E-15 CodexSession.stream yields simplified typed events and ends on settle", {
  skip: skipReason("codex") ?? skipTurns,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  const options: CodexSessionOptions = {
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  };
  const session = new CodexSession(options);
  const seen: TurnEvent[] = [];
  try {
    for await (const event of session.stream(
      "Reply with just one short sentence: hello from Elwood stream.",
    )) {
      seen.push(event);
      // Every yielded event is one of the four simplified content shapes, nothing else.
      assert.ok(
        event.type === "text" ||
          event.type === "thinking" ||
          event.type === "tool_call" ||
          event.type === "tool_result",
        `unexpected stream event type: ${(event as { type: string }).type}`,
      );
    }
    // The iterator ended (turn settled). At least one text event carried the reply.
    const text = seen
      .filter((event): event is Extract<TurnEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    assert.ok(text.trim().length > 0, "stream yielded assistant text before ending");
  } finally {
    await session.close();
  }
});
