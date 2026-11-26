/**
 * Claude's auto-mode setup offer is declined with Esc, spaced past the offer's input guard
 * and retried until a settled frame shows it gone (C-CLAUDE-27, PRD §5.1).
 */
import { expect, test, vi } from "vitest";
import {
  ClaudeAutoModeOfferDecliner,
  type DeclineWriter,
} from "../../src/claude/auto-mode/decline.ts";
import { isClaudeAutoModeOfferMenu } from "../../src/claude/auto-mode/offer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { fakeOfferSpacing } from "../helpers/offer-spacing.ts";

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");
const setupStep = capturedFrame("claude-2.1.332/auto-mode-setup-step");
const idle = "❯ \n";
const spacingMs = 5;

/** A screen the decliner reads, and the writer that records its keys and may close it. */
function screen(closesAfter: number) {
  let text = offer;
  const keys: string[] = [];
  // A plain PTY write settles with no result: only an explicit `withheld` held the key back.
  const write: DeclineWriter = (input, stillValid) => {
    if (!stillValid(text)) return Promise.resolve("withheld" as const);
    keys.push(input);
    if (keys.length >= closesAfter) text = idle;
    return undefined;
  };
  return { keys, write, read: () => text, set: (next: string) => (text = next) };
}

test("C-CLAUDE-27 only the offer's first menu is the decline target, never the setup step", () => {
  expect(isClaudeAutoModeOfferMenu(offer)).toBe(true);
  expect(isClaudeAutoModeOfferMenu(setupStep)).toBe(false);
  expect(isClaudeAutoModeOfferMenu(idle)).toBe(false);
});

test("C-CLAUDE-27 an ignored Esc is retried until a settled frame shows the menu gone", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, spacingMs);
  const { keys, write, read } = screen(2);
  const started = decliner.handle(read(), write, read);
  expect(started?.outcome).toEqual({ kind: "attempted", prompt: "auto_mode_setup", input: "esc" });
  // The same appearance, seen on later frames, is not declined twice.
  expect(decliner.handle(read(), write, read)).toBeUndefined();
  expect(decliner.handle(idle, write, read)).toBeUndefined();
  expect(await started?.settled).toBe("answered");
  expect(keys).toEqual(["\u001b", "\u001b"]);
});

test("C-CLAUDE-27 an offer that outlasts every attempt is left on screen, unclaimed", async () => {
  const lifetime = new AbortController();
  const decliner = new ClaudeAutoModeOfferDecliner(lifetime.signal, spacingMs);
  const { keys, write, read } = screen(Number.POSITIVE_INFINITY);
  expect(await decliner.handle(read(), write, read)?.settled).toBe("cancelled");
  // The contract's cap, not the implementation's constant.
  expect(keys).toHaveLength(4);
  // Still the same appearance: no new decline until the offer has gone and come back.
  expect(decliner.handle(read(), write, read)).toBeUndefined();
  // A frame without the menu is not proof while the settled frame still shows it.
  expect(decliner.handle(idle, write, read)).toBeUndefined();
  expect(decliner.handle(offer, write, read)).toBeUndefined();
  decliner.handle(idle, write, () => idle);
  const next = decliner.handle(offer, write, read);
  expect(next).toBeDefined();
  lifetime.abort();
  expect(await next?.settled).toBe("cancelled");
});

test("C-CLAUDE-27 raw caller input on the offer hands it to the human", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, spacingMs);
  const { keys, write, read } = screen(1);
  decliner.callerInput(); // No offer yet: nothing to hand over.
  const settled = decliner.handle(read(), write, read)?.settled;
  decliner.callerInput();
  expect(await settled).toBe("cancelled");
  expect(keys).toEqual([]);
  // Neither an unsettled frame without the menu nor the setup step `Yes` opens ends the
  // human's appearance; a settled frame without the offer does, and the next is declined.
  decliner.handle(idle, write, read);
  decliner.handle(setupStep, write, () => setupStep);
  expect(decliner.handle(offer, write, read)).toBeUndefined();
  decliner.handle(idle, write, () => idle);
  expect(await decliner.handle(offer, write, read)?.settled).toBe("answered");
});

test("C-CLAUDE-27 a menu that closes or never settles before the first Esc claims nothing", async () => {
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, spacingMs);
  const closing = screen(1);
  expect(decliner.handle(idle, closing.write, closing.read)).toBeUndefined();
  const closed = decliner.handle(closing.read(), closing.write, closing.read)?.settled;
  closing.set(idle);
  expect(await closed).toBe("cancelled");
  expect(closing.keys).toEqual([]);
  // A frame that never settles is not proof either way, and an Esc that is withheld is
  // not one that went out: three such attempts end the decline without a claim.
  const later = new ClaudeAutoModeOfferDecliner(new AbortController().signal, spacingMs);
  let attempts = 0;
  const withheld: DeclineWriter = () => {
    attempts++;
    return Promise.resolve("withheld" as const);
  };
  expect(await later.handle(offer, withheld, () => undefined)?.settled).toBe("cancelled");
  expect(attempts).toBe(3);
});

test("C-CLAUDE-27 caller input after a settled frame shows the dismissal leaves the decline Elwood's", async () => {
  const fakeSpacingMs = fakeOfferSpacing();
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, fakeSpacingMs);
  const { keys, write, read } = screen(1);
  const settled = decliner.handle(read(), write, read)?.settled;
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(keys).toEqual(["\u001b"]);
  // Claude repaints without the menu, and the caller types into the composer before the
  // decline's next check.
  decliner.handle(read(), write, read);
  decliner.callerInput();
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(await settled).toBe("answered");
});

test("C-CLAUDE-27 only a settled frame after an Esc, before caller input, shows Elwood's dismissal", async () => {
  const fakeSpacingMs = fakeOfferSpacing();
  const decliner = new ClaudeAutoModeOfferDecliner(new AbortController().signal, fakeSpacingMs);
  const { keys, write, read } = screen(1);
  const settled = decliner.handle(read(), write, read)?.settled;
  // A frame without the menu before any Esc is not Elwood's dismissal.
  decliner.handle(idle, write, () => idle);
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(keys).toEqual(["\u001b"]);
  // Neither an unsettled frame nor a settled one that still shows the menu proves it.
  decliner.handle(idle, write, () => undefined);
  decliner.handle(idle, write, () => offer);
  decliner.callerInput();
  // Once the caller has typed on the offer, a later frame cannot give it back.
  decliner.handle(idle, write, () => idle);
  await vi.advanceTimersByTimeAsync(fakeSpacingMs);
  expect(await settled).toBe("cancelled");
});

test("C-CLAUDE-27 session close cancels a decline in flight", async () => {
  const lifetime = new AbortController();
  const decliner = new ClaudeAutoModeOfferDecliner(lifetime.signal, spacingMs);
  const { write, read } = screen(1);
  const settled = decliner.handle(read(), write, read)?.settled;
  lifetime.abort();
  expect(await settled).toBe("cancelled");
  expect(decliner.handle(idle, write, read)).toBeUndefined();
  expect(decliner.handle(offer, write, read)).toBeUndefined();
});
