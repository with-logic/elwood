/**
 * Real Claude guidance caught by an interrupt while Claude screens it (PRD §5.4, C-API-62).
 * Claude Code 2.1.332 fires the guidance's `UserPromptSubmit` with the running turn's prompt ID
 * as it queues the guidance. An interrupt while that hook is still held cancels the screening,
 * so Claude fires the hook again under a new prompt ID when it runs the guidance as its own
 * turn. The guidance must still produce exactly one `user_message`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

const marker = "ELWOOD_INTERRUPTED_GUIDANCE";

test("C-API-62 real Claude shows guidance once when an interrupt makes Claude screen it again", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  let guidanceHooks = 0;
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {
      // Hold the guidance's first screening open, so the interrupt lands inside it.
      UserPromptSubmit: async (event) => {
        if (!event.prompt.includes(marker)) return;
        guidanceHooks += 1;
        if (guidanceHooks === 1) await new Promise((resolve) => setTimeout(resolve, 3_000));
      },
    },
  });
  const messages: string[] = [];
  let replied = false;
  session.on("activity", (event) => {
    if (event.kind === "user_message" && event.text.includes(marker)) messages.push(event.text);
    if (event.kind === "assistant_message" && event.text?.includes(marker)) replied = true;
  });
  try {
    await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
    await session.sendMessage(
      "Write a detailed 1,200-word essay about terminal history. Do not use tools.",
    );
    await waitFor(
      () => (/esc to interrupt/i.test(session.terminal.snapshot().text) ? true : undefined),
      "turn visibly running",
      60_000,
    );
    await session.sendGuidance(`Coordinator note: reply with only the word ${marker}.`);
    await waitFor(() => (guidanceHooks === 1 ? true : undefined), "the guidance's hook", 30_000);
    await session.interrupt();
    await waitFor(
      () => (guidanceHooks === 2 ? true : undefined),
      "Claude to screen the guidance again as it runs it",
      60_000,
    );
    await waitFor(() => (replied ? true : undefined), "the guidance turn's reply", 90_000);
    assert.equal(messages.length, 1, `one guidance, one message: ${JSON.stringify(messages)}`);
  } finally {
    await cleanup(session);
  }
});
