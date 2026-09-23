/** Non-trust startup automation never writes into a held trust gate, known or unknown (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

afterEach(() => vi.useRealTimers());

const update = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
/** Off-allowlist gate whose option rows alone satisfy the option-only update recognizer. */
const gate =
  "Do you trust this workspace's updater?\n› 1. Update now\n  2. Skip\n\nPress enter to continue";
const nearMiss = gate.replace("Update now", "Update plugins now");
/** An ALLOWLISTED header with a foreign body: a hold-only candidate the responder never answers. */
const heldKnown = gate.replace(
  /^.*\n/,
  "Do you trust the contents of this directory?\nForeign copy\n",
);

test("C-TRUST-01 Codex update-skip never writes into a held trust gate, first write or retries", async () => {
  vi.useFakeTimers();
  for (const frame of [gate, heldKnown, nearMiss]) {
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
  // The real update screen gets its key; a gate that replaces it mid-retry gets none,
  // and the skip does NOT settle as answered — the update screen never cleared, it was
  // replaced, so reporting success would emit `startup_prompt` for an update that
  // did not take (C-CODEX-12).
  let frame = update;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder("s", true);
  const write = (input: string) => {
    writes.push(input);
    frame = heldKnown;
  };
  const { outcomes } = responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(writes).toEqual(["2"]);
  await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
});

test("C-CODEX-12 an update screen that genuinely clears still settles as answered", async () => {
  // A native idle composer positively confirms clearance. Mere absence of a
  // trust gate is insufficient evidence that the update prompt was answered.
  vi.useFakeTimers();
  let frame = update;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder("s", true);
  const { outcomes } = responder.handle(
    frame,
    (input) => {
      writes.push(input);
      frame = codexSmallComposer;
    },
    () => frame,
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(writes).toEqual(["2"]);
  await expect(outcomes[0]?.settled).resolves.toBe("answered");
});

test("C-TRUST-01 Claude browser-tools decline never writes into a held trust gate", () => {
  const options = "❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
  const writes: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  const write = (input: string) => void writes.push(input);
  const held = `Do you trust this browser?\n${options}\n\nEnter to confirm · Esc to cancel`;
  const heldKnown = held.replace(/^.*\n/, "Do you trust this folder?\nForeign copy\n");
  for (const frame of [held, heldKnown]) expect(responder.handle(frame, write)).toEqual([]);
  expect(writes).toEqual([]);
  // The captured native prompt (its own footer, no header-shaped question) is still declined.
  responder.handle(`${options}\n  Enter to confirm · Esc to keep browser tools off`, write);
  expect(writes).toEqual([String.fromCharCode(27)]);
});
