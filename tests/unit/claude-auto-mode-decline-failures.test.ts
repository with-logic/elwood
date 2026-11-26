/**
 * Claude's auto-mode offer decline makes a bounded number of failed attempts within one
 * appearance, never reopens an appearance, and lets a seen dismissal win (C-CLAUDE-27,
 * PRD §5.1).
 */
import { expect, onTestFinished, test, vi } from "vitest";
import {
  ClaudeAutoModeOfferDecliner,
  type OfferDeclineWriter,
} from "../../src/claude/auto-mode/decline.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");
const idle = "❯ \n";
const esc = "\u001b";
const quickSpacingMs = 5;

/** Fake timers at the real spacing, so a test can act between two attempts. */
function fakeSpacing(): number {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return 750;
}

/** A writer that plays `script` (withheld, rejected or written) and then writes every key. */
function scripted(script: readonly ("withheld" | "rejected" | "written")[]) {
  const keys: string[] = [];
  let calls = 0;
  const write: OfferDeclineWriter = (input) => {
    const step = script[calls++] ?? "written";
    if (step === "withheld") return Promise.resolve("withheld" as const);
    if (step === "rejected") return Promise.reject<void>(new Error("pty write failed"));
    keys.push(input);
    return undefined;
  };
  return { keys, write, calls: () => calls };
}

test("C-CLAUDE-27 a withheld Esc does not spend one of the four Escapes", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, quickSpacingMs);
  const { keys, write } = scripted(["withheld", "withheld"]);
  // The menu never closes: after two withheld attempts, four Escapes still go out.
  expect(await decliner.handle(offer, write, () => offer)?.settled).toBe("cancelled");
  expect(keys).toEqual([esc, esc, esc, esc]);
});

test("C-CLAUDE-27 a rejected Esc is retried within the appearance", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, quickSpacingMs);
  let screen = offer;
  const { keys, write } = scripted(["rejected"]);
  const closing: OfferDeclineWriter = (input, stillValid) => {
    const result = write(input, stillValid);
    if (keys.length > 0) screen = idle;
    return result;
  };
  expect(await decliner.handle(offer, closing, () => screen)?.settled).toBe("answered");
  expect(keys).toEqual([esc]);
});

test("C-CLAUDE-27 three failed writes end the decline, report the rejection, and do not reopen it", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, quickSpacingMs);
  const { keys, write, calls } = scripted(["rejected", "withheld", "withheld"]);
  await expect(decliner.handle(offer, write, () => offer)?.settled).rejects.toThrow(
    "pty write failed",
  );
  expect(calls()).toBe(3);
  expect(keys).toEqual([]);
  // The same appearance is never declined again; only one after the menu leaves is.
  expect(decliner.handle(offer, write, () => offer)).toBeUndefined();
  decliner.handle(idle, write, () => idle);
  expect(decliner.handle(offer, write, () => offer)).toBeDefined();
});

test("C-CLAUDE-27 caller input after a rejected Esc keeps the appearance the human's", async () => {
  const fakeSpacingMs = fakeSpacing();
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, fakeSpacingMs);
  const { keys, write, calls } = scripted(["rejected"]);
  const settled = decliner.handle(offer, write, () => offer)?.settled;
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(calls()).toBe(1);
  decliner.callerInput();
  // Later frames still show the menu, and none of them restarts the decline.
  expect(decliner.handle(offer, write, () => offer)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(fakeSpacingMs * 4);
  expect(await settled).toBe("cancelled");
  expect(keys).toEqual([]);
  expect(decliner.handle(offer, write, () => offer)).toBeUndefined();
});

test("C-CLAUDE-27 a dismissal a frame showed wins over an unreadable frame after the fourth Esc", async () => {
  const fakeSpacingMs = fakeSpacing();
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, fakeSpacingMs);
  const { keys, write } = scripted([]);
  let settledFrame: string | undefined = offer;
  const settled = decliner.handle(offer, write, () => settledFrame)?.settled;
  await vi.advanceTimersByTimeAsync(fakeSpacingMs * 4);
  expect(keys).toEqual([esc, esc, esc, esc]);
  // Claude repaints without the menu, but the decline's own read finds rendering pending.
  settledFrame = undefined;
  decliner.handle(idle, write, () => idle);
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(await settled).toBe("answered");
});

test("C-CLAUDE-27 a settled frame that stays unreadable after the fourth Esc ends the decline", async () => {
  const fakeSpacingMs = fakeSpacing();
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, fakeSpacingMs);
  const { keys, write } = scripted([]);
  let settledFrame: string | undefined = offer;
  const settled = decliner.handle(offer, write, () => settledFrame)?.settled;
  await vi.advanceTimersByTimeAsync(fakeSpacingMs * 4);
  settledFrame = undefined;
  await vi.advanceTimersByTimeAsync(fakeSpacingMs * 3);
  expect(await settled).toBe("cancelled");
  expect(keys).toHaveLength(4);
});
