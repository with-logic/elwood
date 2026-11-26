/**
 * An update skip that has ended leaves no listener on the session's lifetime signal, so a
 * long session that meets the offer again and again does not collect them (PRD §5.5,
 * C-CODEX-27).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const capture = (name: string) => capturedFrame(`codex-0.172.0/update/${name}`);
const offer = capture("offer-standalone-100x30");
const repaint = ["start-boot-partial", "start-boot-composer"].map(capture);
const composer = capture("start-skipped-composer");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Abort listeners added from now on, read as those still waiting: not removed, on a signal
 * that has not aborted (an abort runs and drops each listener once).
 */
function liveAbortListeners(): () => unknown[] {
  const added = new Map<unknown, EventTarget>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    if (type === "abort") added.set(listener, this);
    add.call(this, type, listener, options);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    if (type === "abort") added.delete(listener);
    remove.call(this, type, listener, options);
  });
  return () =>
    [...added]
      .filter(([, target]) => !(target instanceof AbortSignal && target.aborted))
      .map(([listener]) => listener);
}

test("C-CODEX-27 a skip that has ended leaves no listener on the session", async () => {
  let frame = offer;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder(
    "listeners",
    false,
    undefined,
    codexComposerClearance,
    () => false,
  );
  const show = (text: string) => {
    frame = text;
    responder.handle(
      text,
      (key) => void writes.push(key),
      () => frame,
    );
    responder.observeClearance(text);
  };
  const live = liveAbortListeners();
  for (const text of [offer, ...repaint, composer]) {
    show(text);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(writes).toEqual(["2"]);
  expect(responder.inputBlocking).toBe(false);
  expect(live()).toEqual([]);
  responder.dispose();
});

test("C-CODEX-27 a key answered by the configured composer while it went out leaves no listener", async () => {
  let frame = offer;
  const pending = Promise.withResolvers<"written">();
  const responder = new CodexStartupPromptResponder(
    "listeners",
    false,
    undefined,
    codexComposerClearance,
    () => false,
  );
  const show = (text: string) => {
    frame = text;
    const write = () => undefined;
    const result = responder.handle(
      text,
      write,
      () => frame,
      () => pending.promise,
    );
    responder.observeClearance(text);
    return result;
  };
  const live = liveAbortListeners();
  const [skip] = show(offer).outcomes;
  await vi.advanceTimersByTimeAsync(0);
  show(composer);
  pending.resolve("written");
  await expect(skip?.settled).resolves.toBe("answered");
  await vi.advanceTimersByTimeAsync(0);
  expect(live()).toEqual([]);
  responder.dispose();
});
