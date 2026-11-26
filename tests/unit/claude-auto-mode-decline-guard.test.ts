/**
 * Claude's auto-mode offer decline through the real guarded writer, on fixed contract timing:
 * Esc 750 ms after the menu and 750 ms apart, at most four times, never after raw caller
 * input and never onto a screen that replaced the menu (C-CLAUDE-26, PRD §5.1).
 */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeAutoModeOfferDecliner } from "../../src/claude/auto-mode-decline.ts";
import { guardedClaudeAutomationWrite } from "../../src/claude/startup-prompts.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

afterEach(() => {
  vi.useRealTimers();
});

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");
// A prompt the Claude automation guard also accepts, so only the decline's own check withholds.
const browserTools =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
const esc = "\u001b";

/** A screen showing the offer, whose settlement can be held, and the decline it starts. */
function declining() {
  vi.useFakeTimers();
  const screen = { text: offer, held: undefined as PromiseWithResolvers<void> | undefined };
  const writes: { readonly input: string; readonly at: number }[] = [];
  let settles = 0;
  const write = guardedClaudeAutomationWrite(
    {
      sendInput: () => undefined,
      settled: () => {
        settles += 1;
        return screen.held?.promise ?? Promise.resolve();
      },
      renderFailed: false,
    },
    (input) => void writes.push({ input, at: Date.now() }),
    () => screen.text,
  );
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal);
  const start = Date.now();
  const settled = decliner.handle(screen.text, write, () => screen.text)?.settled;
  return {
    screen,
    decliner,
    settled,
    settles: () => settles,
    escapes: () => writes.map(({ input, at }) => ({ input, ms: at - start })),
  };
}

test("C-CLAUDE-26 an ignored offer gets four Escapes 750 ms apart, then is left alone", async () => {
  const { settled, escapes } = declining();
  await vi.advanceTimersByTimeAsync(749);
  expect(escapes()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(escapes()).toEqual([{ input: esc, ms: 750 }]);
  await vi.advanceTimersByTimeAsync(749);
  expect(escapes()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(escapes()).toEqual([750, 1_500, 2_250, 3_000].map((ms) => ({ input: esc, ms })));
  expect(await settled).toBe("cancelled");
});

test("C-CLAUDE-26 caller input while an Esc waits for settlement withholds it", async () => {
  const { screen, decliner, settled, settles, escapes } = declining();
  screen.held = Promise.withResolvers<void>();
  await vi.advanceTimersByTimeAsync(750);
  expect(settles()).toBe(1);
  // The Esc is parked on settlement, with the offer still on screen, when the human types.
  decliner.callerInput();
  screen.held.resolve();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(escapes()).toEqual([]);
  expect(await settled).toBe("cancelled");
});

test("C-CLAUDE-26 caller input after the first Esc stops the retries", async () => {
  const { decliner, settled, escapes } = declining();
  await vi.advanceTimersByTimeAsync(750);
  expect(escapes()).toHaveLength(1);
  decliner.callerInput();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(escapes()).toHaveLength(1);
  expect(await settled).toBe("cancelled");
});

test("C-CLAUDE-26 an Esc is withheld when settlement replaces the menu, and claims nothing", async () => {
  const { screen, settled, settles, escapes } = declining();
  screen.held = Promise.withResolvers<void>();
  await vi.advanceTimersByTimeAsync(750);
  expect(settles()).toBe(1);
  screen.text = browserTools;
  screen.held.resolve();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(escapes()).toEqual([]);
  // Withheld, never written: a menu gone without Elwood's Esc is not reported as declined.
  expect(await settled).toBe("cancelled");
});
