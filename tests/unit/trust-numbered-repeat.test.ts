/**
 * What a numbered trust answer may write again: Enter alone for Codex while its caret is on
 * the affirmative, otherwise the number only after output shows the gate kept (C-TRUST-01).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
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

test("C-TRUST-01 Codex retries its numbered answer with Enter alone while the caret is on it", async () => {
  const frame = `${codexTrust}\n› 1. Yes, continue\n  2. No, quit\nPress enter to continue`;
  const write = vi.fn();
  new TrustPromptResponder("codex", codexTrustClearance, true).handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls[0]).toEqual(["1\r"]);
  expect(write.mock.calls.length).toBeGreaterThan(1);
  expect(write.mock.calls.slice(1).every(([input]) => input === "\r")).toBe(true);
});

test("C-TRUST-01 Claude never gets a bare Enter, even with its caret on the numbered answer", async () => {
  // Claude remounts its list with the caret on the decline, so Enter alone could exit.
  const frame = `${claudeTrust}\n❯ 1. Yes\n  2. No`;
  const write = vi.fn();
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls).toEqual([["1\r"]]);
  responder.handle(frame, write, () => frame); // output after the answer still shows it
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls).toEqual([["1\r"], ["1\r"]]);
});
