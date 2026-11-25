/**
 * After Elwood's skip key, Codex 0.171+ repaints its boot composer or resume placeholder
 * before its configured composer. The skip owns that repaint: input stays held and no
 * dialog is reported until the configured composer, a bound, or another owner ends it
 * (PRD §5.5, C-CODEX-27).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { repaintGraceMs, repaintOwnershipMs } from "../../src/codex/update/skip-attempt.ts";
import { codexTrust } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const capture = (name: string) => capturedFrame(`codex-0.172.0/update/${name}`);
const offer = capture("offer-standalone-100x30");
const start = ["start-boot-partial", "start-boot-composer", "start-notice-partial"].map(capture);
const resume = ["resume-placeholder", "resume-notice-partial"].map(capture);
const startComposer = capture("start-skipped-composer");
const resumeComposer = capture("resume-skipped-composer");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A responder fed frames the way a session renders them, with its key already written. */
async function skipped() {
  let frame = offer;
  const writes: string[] = [];
  const released = vi.fn();
  const responder = new CodexStartupPromptResponder(
    "repaint",
    false,
    released,
    codexComposerClearance,
    () => false,
  );
  const show = (text: string) => {
    frame = text;
    const result = responder.handle(
      text,
      (key) => void writes.push(key),
      () => frame,
    );
    responder.observeClearance(text);
    return result;
  };
  const [skip] = show(offer).outcomes;
  let settled: unknown;
  void skip?.settled?.then((value) => {
    settled = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  if (writes.join() !== "2") throw new Error(`the offer took ${JSON.stringify(writes)}`);
  return {
    responder,
    show,
    writes,
    released,
    settled: () => settled,
    async step(text: string) {
      show(text);
      await vi.advanceTimersByTimeAsync(0);
      return responder.inputBlocking;
    },
  };
}

test.each([
  ["start", start, startComposer],
  ["resume", resume, resumeComposer],
] as const)("C-CODEX-27 a %s holds input over Codex's repaint and answers on its composer", async (_launch, repaint, composer) => {
  const s = await skipped();
  for (const frame of repaint) expect(await s.step(frame)).toBe(true);
  expect(s.settled()).toBe("answered");
  expect(await s.step(composer)).toBe(false);
  await vi.advanceTimersByTimeAsync(repaintOwnershipMs);
  expect(s.writes).toEqual(["2"]);
  expect(s.released).not.toHaveBeenCalled();
  s.responder.dispose();
});

test("C-CODEX-27 the grace bound releases a repaint that never shows Codex's composer", async () => {
  const s = await skipped();
  expect(await s.step("")).toBe(true);
  await vi.advanceTimersByTimeAsync(repaintGraceMs - 1);
  expect(s.responder.inputBlocking).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.responder.inputBlocking).toBe(false);
  expect(s.settled()).toBe("cancelled");
  expect(s.released).toHaveBeenCalledOnce();
  // A released repaint is not taken back by a later frame.
  expect(await s.step(start[0]!)).toBe(false);
  expect(s.writes).toEqual(["2"]);
});

test("C-CODEX-27 the ownership bound releases an answered repaint", async () => {
  const s = await skipped();
  expect(await s.step(start[1]!)).toBe(true);
  expect(s.settled()).toBe("answered");
  await vi.advanceTimersByTimeAsync(repaintOwnershipMs - 1);
  expect(s.responder.inputBlocking).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.responder.inputBlocking).toBe(false);
  expect(s.settled()).toBe("answered");
  expect(s.released).toHaveBeenCalledOnce();
});

test("C-CODEX-27 a dialog after the key ends the repaint unanswered", async () => {
  const s = await skipped();
  expect(await s.step(start[0]!)).toBe(true);
  expect(await s.step("Enable the new context cache?\n› 1. Enable now\n  2. Later")).toBe(false);
  expect(s.settled()).toBe("cancelled");
  // The released repaint is not taken back by Codex's composer.
  expect(await s.step(start[1]!)).toBe(false);
  await vi.advanceTimersByTimeAsync(repaintOwnershipMs);
  expect(s.settled()).toBe("cancelled");
  expect(s.writes).toEqual(["2"]);
  expect(s.released).not.toHaveBeenCalled();
});

test("C-CODEX-27 a trust prompt after the key leaves the screen to trust", async () => {
  const s = await skipped();
  expect(await s.step(start[0]!)).toBe(true);
  s.show(codexTrust);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.settled()).toBe("cancelled");
  await vi.advanceTimersByTimeAsync(repaintOwnershipMs);
  expect(s.writes).toEqual(["2"]);
  expect(s.released).not.toHaveBeenCalled();
});

test("C-CODEX-27 the prompt drawn again after the key is a new appearance", async () => {
  const s = await skipped();
  expect(await s.step(start[0]!)).toBe(true);
  const [again] = s.show(offer).outcomes;
  await vi.advanceTimersByTimeAsync(0);
  expect(s.settled()).toBe("cancelled");
  expect(s.responder.inputBlocking).toBe(false);
  expect(s.writes).toEqual(["2", "2"]);
  expect(await s.step(start[1]!)).toBe(true);
  await expect(again?.settled).resolves.toBe("answered");
  expect(await s.step(startComposer)).toBe(false);
});

test.each([
  ["caller input", (responder: CodexStartupPromptResponder) => responder.callerInput()],
  ["disposal", (responder: CodexStartupPromptResponder) => responder.dispose()],
])("C-CODEX-27 %s releases the repaint", async (_name, end) => {
  const s = await skipped();
  expect(await s.step(start[0]!)).toBe(true);
  end(s.responder);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.responder.inputBlocking).toBe(false);
  expect(s.settled()).toBe("cancelled");
  await vi.advanceTimersByTimeAsync(repaintOwnershipMs);
  expect(s.released).not.toHaveBeenCalled();
});

test("C-CODEX-27 a newer prompt before Codex's repaint takes the screen from the old key", async () => {
  const s = await skipped();
  // A newer release's prompt offers no safe choice, so no attempt of its own starts.
  const newer = offer.replace("99.0.0", "99.1.0").replace(/^ {2}[23]\. Skip.*\n/gm, "");
  expect(s.show(newer).outcomes).toEqual([]);
  expect(await s.step("")).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(s.settled()).toBe("cancelled");
  expect(s.writes).toEqual(["2"]);
});

test("C-CODEX-27 a key that has not gone out owns no repaint", async () => {
  const responder = new CodexStartupPromptResponder(
    "repaint",
    false,
    undefined,
    codexComposerClearance,
  );
  const pending = Promise.withResolvers<"written">();
  const [skip] = responder.handle(
    offer,
    () => undefined,
    () => "",
    () => pending.promise,
  ).outcomes;
  responder.handle("", () => undefined);
  expect(responder.inputBlocking).toBe(false);
  responder.dispose();
  pending.resolve("written");
  await expect(skip?.settled).resolves.toBe("cancelled");
});
