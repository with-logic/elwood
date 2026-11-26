/**
 * How Codex readiness waits for a requested effort's label, and for how long: until 50 s after
 * launch when the first frame comes earlier, else until the deadline (PRD §5.3, C-API-28).
 */

import { afterEach, expect, test, vi } from "vitest";
import { codexConfiguredCheck } from "../../src/codex/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
const unpainted = effortDefault.replace(/^ {2}GPT-6-Luna default$/m, "");

/** Spies for both events, which production runs contained, so a test asserts on them. */
function waitEvents() {
  return { onWaitEnded: vi.fn(), onUnconfirmed: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

test.each([
  undefined,
  "none",
] as const)("C-API-28 with effort %s the default footer counts at once", (effort) => {
  vi.useFakeTimers();
  const events = waitEvents();
  const check = codexConfiguredCheck(effort, events);
  check.arm();
  expect(vi.getTimerCount()).toBe(0);
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(check.configured(unpainted, 140)).toBe(false);
  expect(events.onWaitEnded).not.toHaveBeenCalled();
  expect(events.onUnconfirmed).not.toHaveBeenCalled();
});

test("C-API-28 once Codex showed the requested effort a default label cannot revoke it", () => {
  const events = waitEvents();
  const { configured } = codexConfiguredCheck("low", events);
  expect(configured(effortDefault, 140)).toBe(false);
  expect(configured(effortLow, 140)).toBe(true);
  expect(configured(effortDefault, 140)).toBe(true);
  expect(configured(unpainted, 140)).toBe(false);
  expect(events.onUnconfirmed).not.toHaveBeenCalled();
});

test("C-API-28 the wait for the effort label ends 50 s after launch when the first frame comes earlier", () => {
  vi.useFakeTimers();
  const onWaitEnded = vi.fn(() => {
    throw new Error("a throwing re-read cannot hold readiness");
  });
  const onUnconfirmed = vi.fn(() => {
    throw new Error("a throwing warning sink cannot hold readiness");
  });
  const check = codexConfiguredCheck("low", { onWaitEnded, onUnconfirmed });
  // Only the first frame arms the timer, but the time before it counts.
  vi.advanceTimersByTime(30_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(check.configured(effortDefault, 140)).toBe(false);
  check.arm();
  check.arm();
  vi.advanceTimersByTime(19_999);
  expect(onWaitEnded).not.toHaveBeenCalled();
  expect(check.configured(effortDefault, 140)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(onWaitEnded).toHaveBeenCalledOnce();
  expect(check.configured(unpainted, 140)).toBe(false);
  expect(onUnconfirmed).not.toHaveBeenCalled();
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(onUnconfirmed).toHaveBeenCalledOnce();
});

test("C-API-28 a first frame drawn after 40 s ends the wait with the deadline, not before it", () => {
  vi.useFakeTimers();
  const events = waitEvents();
  const check = codexConfiguredCheck("low", events);
  vi.advanceTimersByTime(45_000);
  check.arm();
  // 50 s after launch the deadline, 10 s after that frame, is still to come.
  vi.advanceTimersByTime(9_999);
  expect(events.onWaitEnded).not.toHaveBeenCalled();
  expect(check.configured(effortDefault, 140)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(events.onWaitEnded).toHaveBeenCalledOnce();
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(events.onUnconfirmed).toHaveBeenCalledOnce();
});

test("C-API-28 a wall-clock step before the first frame cannot move the end of the wait", () => {
  vi.useFakeTimers();
  const events = waitEvents();
  const check = codexConfiguredCheck("low", events);
  vi.advanceTimersByTime(30_000);
  // The system clock steps back a minute, as an NTP correction or a manual change can.
  vi.setSystemTime(Date.now() - 60_000);
  check.arm();
  vi.advanceTimersByTime(20_000);
  expect(events.onWaitEnded).toHaveBeenCalledOnce();
  expect(check.configured(effortDefault, 140)).toBe(true);
});

test("C-API-28 a stopped check never lapses", () => {
  vi.useFakeTimers();
  const events = waitEvents();
  const check = codexConfiguredCheck("low", events);
  check.arm();
  check.stop();
  check.arm();
  vi.advanceTimersByTime(120_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(check.configured(effortDefault, 140)).toBe(false);
  expect(events.onWaitEnded).not.toHaveBeenCalled();
});
