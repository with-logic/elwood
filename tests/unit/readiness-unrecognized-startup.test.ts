/** The readiness gate's deadline starts unrecognized startup screens (PRD §5.4, C-ATTN-09). */
import { afterEach, expect, test, vi } from "vitest";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { noStartupScreens } from "../helpers/startup-screens.ts";

afterEach(() => vi.useRealTimers());

const idle = { composer_visible: false, blocking_prompt_visible: false, working_visible: false };
const screen = { text: "Choose the text style" };

function gate(onBackstop = vi.fn()) {
  const ready = vi.fn();
  const subject = createReadinessGate(ready, false, {
    ...noStartupScreens,
    nativeStartupScreen: (frame) => frame === "boot composer",
    configured: (frame) => frame === "configured composer",
    onBackstop,
  });
  const reread = vi.fn();
  subject.setDeadlineListener(reread);
  return { subject, ready, reread, onBackstop };
}

test("C-ATTN-09 the deadline re-reads the frame when readiness did not fire", () => {
  vi.useFakeTimers();
  const { subject, reread } = gate();
  subject.observeReadinessFrame(idle, false, screen.text);
  subject.ready.armDeadline();
  vi.advanceTimersByTime(9_999);
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(false);
  expect(reread).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(reread).toHaveBeenCalledOnce();
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(true);
});

test("C-ATTN-09 a deadline that fires readiness re-reads nothing", () => {
  vi.useFakeTimers();
  const { subject, ready, reread } = gate();
  subject.observeReadinessFrame({ ...idle, composer_visible: true }, false, "configured composer");
  subject.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
  expect(ready).toHaveBeenCalledOnce();
  expect(reread).not.toHaveBeenCalled();
});

test("C-ATTN-09 readiness after the deadline ends unrecognized startup screens", () => {
  vi.useFakeTimers();
  const { subject, ready } = gate();
  subject.observeReadinessFrame(idle, false, screen.text);
  subject.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(true);
  subject.observeReadinessFrame({ ...idle, composer_visible: true }, false, "configured composer");
  expect(ready).toHaveBeenCalledOnce();
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(false);
});

test("C-ATTN-09 a throwing re-read is contained and the backstop still runs", () => {
  vi.useFakeTimers();
  const { subject, onBackstop } = gate();
  subject.setDeadlineListener(() => {
    throw new Error("re-read failed");
  });
  subject.observeReadinessFrame(idle, false, screen.text);
  subject.ready.armDeadline();
  expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  expect(onBackstop).toHaveBeenCalledOnce();
});

const dialog = { ...idle, blocking_prompt_visible: true };

test.each([
  ["an unrecognized startup screen's block is no recognized dialog", idle, true, false],
  ["a recognized dialog is one", dialog, false, true],
] as const)("C-ATTN-06 C-ATTN-09 at the backstop %s", (_, facts, unrecognized, dialogHeld) => {
  vi.useFakeTimers();
  const { subject, onBackstop } = gate();
  subject.observeReadinessFrame(idle, false, screen.text);
  subject.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
  expect(subject.unrecognizedStartup.classify(facts, false, screen)).toBe(unrecognized);
  // The frame observer makes an unrecognized screen blocking before the gate reads it.
  subject.observeReadinessFrame(dialog, false, screen.text);
  vi.advanceTimersByTime(50_000);
  expect(onBackstop).toHaveBeenCalledWith(dialogHeld);
});

test.each([
  ["a blank frame", " \n "],
  ["a native startup frame", "boot composer"],
])("C-ATTN-06 C-ATTN-09 %s inside the block leaves it no recognized dialog at the backstop", (_, text) => {
  vi.useFakeTimers();
  const { subject, onBackstop } = gate();
  subject.observeReadinessFrame(idle, false, screen.text);
  subject.ready.armDeadline();
  vi.advanceTimersByTime(10_000);
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(true);
  subject.observeReadinessFrame(dialog, false, screen.text);
  expect(subject.unrecognizedStartup.classify(idle, false, { text })).toBe(false);
  subject.observeReadinessFrame(idle, false, text);
  vi.advanceTimersByTime(50_000);
  expect(onBackstop).toHaveBeenCalledWith(false);
});

test("C-ATTN-09 a gate without adapter evidence classifies no frame and never re-reads", () => {
  vi.useFakeTimers();
  const subject = createReadinessGate(() => {}, false);
  const reread = vi.fn();
  subject.setDeadlineListener(reread);
  subject.ready.armDeadline();
  vi.advanceTimersByTime(60_000);
  expect(reread).not.toHaveBeenCalled();
  expect(subject.unrecognizedStartup.classify(idle, false, screen)).toBe(false);
});
