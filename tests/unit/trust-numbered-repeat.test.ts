/**
 * What a numbered trust answer may write again: with Codex's adapter retry, Enter alone
 * while its caret is on the affirmative; otherwise the number only after output shows the
 * gate kept (C-TRUST-01).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { codexNumberedRetry } from "../../src/codex/trust-retry.ts";
import { selectableOptions } from "../../src/core/terminal-options.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { claudeTrust, codexTrust } from "../fixtures/trust-composer.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-TRUST-01 only the option on the caret's row is selected", () => {
  expect(selectableOptions("› 1. Yes 2. No")).toEqual([
    { style: "numbered", label: "Yes", number: "1", selected: true },
    { style: "numbered", label: "No", number: "2" },
  ]);
  expect(selectableOptions("  1. Yes\n❯ 2. No")).toEqual([
    { style: "numbered", label: "Yes", number: "1" },
    { style: "numbered", label: "No", number: "2", selected: true },
  ]);
});

test("C-TRUST-01 Codex's adapter retries its numbered answer with Enter alone while the caret is on it", async () => {
  const frame = `${codexTrust}\n› 1. Yes, continue\n  2. No, quit\nPress enter to continue`;
  const write = vi.fn<(input: string) => void>();
  new TrustPromptResponder("codex", codexTrustClearance, true, {
    numberedRetry: codexNumberedRetry,
  }).handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls[0]).toEqual(["1\r"]);
  expect(write.mock.calls.length).toBeGreaterThan(1);
  expect(write.mock.calls.slice(1).every(([input]) => input === "\r")).toBe(true);
});

test("C-TRUST-01 Claude never gets a bare Enter, even with its caret on the numbered answer", async () => {
  // Claude remounts its list with the caret on the decline, so Enter alone could exit.
  const frame = `${claudeTrust}\n❯ 1. Yes\n  2. No`;
  const write = vi.fn<(input: string) => void>();
  const responder = new ClaudeStartupPromptResponder(true); // Claude's own adapter wiring
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls).toEqual([["1\r"]]);
  responder.handle(frame, write, () => frame); // output after the answer still shows it
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls).toEqual([["1\r"], ["1\r"]]);
});

test.each<[string, readonly string[]]>([
  ["first answer", ["1\r"]],
  ["retry", ["1\r", "\r"]],
])("C-TRUST-01 a rejected %s leaves the gate typed: the next attempt never retypes blind", async (_, before) => {
  const frame = `${codexTrust}\n› 1. Yes, continue\n  2. No, quit\nPress enter to continue`;
  const writes: string[] = [];
  const write = (input: string) => {
    writes.push(input);
    return writes.length === before.length
      ? Promise.reject(new Error("PTY write failed"))
      : undefined;
  };
  const responder = new TrustPromptResponder("codex", codexTrustClearance, true, {
    numberedRetry: codexNumberedRetry,
  });
  const first = responder.handle(frame, write, () => frame);
  if (first?.kind !== "attempted") throw new Error("expected attempt");
  const failed = expect(first.settled).rejects.toThrow("PTY write failed");
  await vi.advanceTimersByTimeAsync(260);
  await failed;
  expect(writes).toEqual(before);
  // A rejected write may still have reached Codex, which may have taken "1\r" already:
  // its stale gate gets Enter alone, never the number.
  expect(responder.handle(frame, write, () => frame)?.kind).toBe("attempted");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes.slice(before.length).length).toBeGreaterThan(0);
  expect(writes.slice(before.length).every((input) => input === "\r")).toBe(true);
});
