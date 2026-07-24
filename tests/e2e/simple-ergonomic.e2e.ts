/**
 * Real-CLI e2e for the ergonomic `send`/`stream` facade (PRD §5.8).
 * Implements C-E2E-14 (send collects a turn's assistant text and multi-turn context is
 * retained) and C-E2E-15 (stream yields simplified typed events and ends on settle).
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("C-E2E-15 CodexSession.stream yields a real tool_call/tool_result pair and assistant text, then ends", {
  skip: skipReason("codex") ?? skipTurns,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  writeFileSync(join(project.cwd, "MARKER.txt"), "elwood-marker\n"); // a file the tool must read
  const options: CodexSessionOptions = {
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  };
  const session = new CodexSession(options);
  const seen: TurnEvent[] = [];
  try {
    // A task that requires a real workspace tool (read the file), so the stream produces a
    // deterministic tool_call → tool_result before the assistant text.
    for await (const event of session.stream(
      "Read the file MARKER.txt in the current directory using your tools, then reply with just its contents.",
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
    // The iterator ended (turn settled). Assert a tool_call was followed by its tool_result,
    // and assistant text was yielded — the full stream contract, not just "some text".
    const callIndex = seen.findIndex((e) => e.type === "tool_call");
    const resultIndex = seen.findIndex((e) => e.type === "tool_result");
    assert.ok(callIndex >= 0, "stream yielded a tool_call for the file read");
    assert.ok(resultIndex > callIndex, "the tool_result followed its tool_call, in order");
    const text = seen
      .filter((event): event is Extract<TurnEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    assert.ok(text.trim().length > 0, "stream yielded assistant text after the tool result");
  } finally {
    await session.close();
  }
});
