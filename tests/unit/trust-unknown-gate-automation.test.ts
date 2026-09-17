/** Non-trust startup automation never writes into an off-allowlist gate hold (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";

afterEach(() => vi.useRealTimers());

const update = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
/** Off-allowlist gate whose option rows alone satisfy the option-only update recognizer. */
const gate =
  "Do you trust this workspace's updater?\n› 1. Update now\n  2. Skip\n\nPress enter to continue";
const nearMiss = gate.replace("Update now", "Update plugins now");

test("C-TRUST-01 Codex update-skip leaves an off-allowlist gate unwritten, first write and retries", async () => {
  vi.useFakeTimers();
  for (const frame of [gate, nearMiss]) {
    const writes: string[] = [];
    const held = new CodexStartupPromptResponder("s", true);
    const { outcomes } = held.handle(
      frame,
      (input) => void writes.push(input),
      () => frame,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(outcomes).toEqual([]);
    expect(writes).toEqual([]);
  }
  // The real update screen is answered; a gate that replaces it mid-retry gets no key.
  let frame = update;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder("s", true);
  const write = (input: string) => {
    writes.push(input);
    frame = gate;
  };
  const { outcomes } = responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(writes).toEqual(["2"]);
  await expect(outcomes[0]?.settled).resolves.toBe("answered");
});

test("C-TRUST-01 Claude browser-tools decline leaves an off-allowlist gate unwritten", () => {
  const options = "❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
  const writes: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  const write = (input: string) => void writes.push(input);
  const held = `Do you trust this browser?\n${options}\n\nEnter to confirm · Esc to cancel`;
  expect(responder.handle(held, write)).toEqual([]);
  expect(writes).toEqual([]);
  // The captured native prompt (its own footer, no header-shaped question) is still declined.
  responder.handle(`${options}\n  Enter to confirm · Esc to keep browser tools off`, write);
  expect(writes).toEqual([String.fromCharCode(27)]);
});
