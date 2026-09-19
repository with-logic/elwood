/**
 * A WITHHELD automated write is not an answer: it emits no success completion and leaves
 * the prompt retryable on a later frame (PRD §5.1/§5.4, C-CLAUDE-16, C-CODEX-12, #42).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  ClaudeStartupPromptResponder,
  guardedClaudeAutomationWrite,
} from "../../src/claude/startup-prompts.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import {
  codexOptionStillSafe,
  guardedCodexAutomationWrite,
  writeCodexUpdateSkip,
} from "../../src/codex/update/index.ts";
import { guardedNonTrustAutomationWrite } from "../../src/core/startup/barrier.ts";

const browserPrompt =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
const claudeTrust =
  "Do you trust this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel";
const updateScreen = "Update available! 0.148.0 -> 0.149.1\n› 1. Update now\n  2. Skip";
const codexTrust =
  "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";

// Unconditional, so a failed assertion cannot leave fake timers installed for later files.
afterEach(() => {
  vi.useRealTimers();
});

const clearTerminal = {
  sendInput: () => undefined,
  settled: () => Promise.resolve(),
  renderFailed: false,
};

test("C-CLAUDE-16 a withheld browser decline settles cancelled and retries on a later frame", async () => {
  const writes: string[] = [];
  let frame = claudeTrust; // the settled frame holds a gate, so the Escape is withheld
  const guarded = guardedNonTrustAutomationWrite(
    clearTerminal,
    (input: string) => void writes.push(input),
    () => frame,
    "claude",
  );
  const responder = new ClaudeStartupPromptResponder(true);
  const first = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    guarded,
  );
  const completions = await Promise.all(
    first.map((outcome) => ("settled" in outcome ? outcome.settled : undefined)),
  );
  // Not "answered": nothing reached the PTY, so no `startup_prompt` success is emitted.
  expect(completions).toEqual(["cancelled"]);
  expect(writes).toEqual([]);
  // The gate cleared, so the decline is NOT latched off — a later frame retries it.
  frame = browserPrompt;
  const second = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    guarded,
  );
  await Promise.all(second.map((outcome) => ("settled" in outcome ? outcome.settled : undefined)));
  expect(writes).toEqual(["\u001b"]);
});

test("C-CODEX-12 a withheld update skip settles cancelled rather than answered", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const frame = codexTrust; // a gate replaced the update screen before the key went out
  const guarded = guardedNonTrustAutomationWrite(
    clearTerminal,
    (input: string) => void writes.push(input),
    () => frame,
    "codex",
    codexOptionStillSafe,
  );
  const responder = new CodexStartupPromptResponder("s", true);
  const { outcomes } = responder.handle(
    updateScreen,
    () => undefined,
    () => updateScreen,
    guarded,
  );
  await vi.advanceTimersByTimeAsync(6_000);
  await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual([]);
});

test("C-CLAUDE-16 the decline is withheld when its own prompt cleared during settlement", async () => {
  // The Escape is only correct while the browser prompt is on screen. If a composer
  // replaced it while rendering settled, sending Escape would clear staged text.
  const writes: string[] = [];
  let frame = browserPrompt;
  const guarded = guardedClaudeAutomationWrite(
    {
      sendInput: () => undefined,
      settled: () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            frame = "\u276f \n  (ready)";
            resolve();
          });
        }),
      renderFailed: false,
    },
    (input: string) => void writes.push(input),
    () => frame,
  );
  const responder = new ClaudeStartupPromptResponder(true);
  const outcomes = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    guarded,
  );
  const completions = await Promise.all(
    outcomes.map((outcome) => ("settled" in outcome ? outcome.settled : undefined)),
  );
  expect(writes).toEqual([]);
  expect(completions).toEqual(["cancelled"]);
});

test("C-CODEX-12 a withheld write with no reader settles cancelled, not answered", async () => {
  const writes: string[] = [];
  const guarded = guardedCodexAutomationWrite(
    clearTerminal,
    (input: string) => void writes.push(input),
    () => codexTrust,
  );
  // No `readFrame`: there is nothing to retry from, but a key nobody sent is still
  // not an answer, so it must not report success.
  await expect(writeCodexUpdateSkip("2", guarded)).resolves.toBe("cancelled");
  expect(writes).toEqual([]);
});
