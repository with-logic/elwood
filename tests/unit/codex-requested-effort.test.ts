/** How Codex readiness waits for a requested effort's label, and for how long (PRD §5.3, C-API-28). */

import { afterEach, expect, test, vi } from "vitest";
import { codexConfiguredCheck } from "../../src/codex/session/readiness.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
const unpainted = effortDefault.replace(/^ {2}GPT-6-Luna default$/m, "");
const noLapse = () => {
  throw new Error("the wait for the effort label lapsed");
};

afterEach(() => {
  vi.useRealTimers();
});

test("C-API-28 without a requested effort the default footer counts", () => {
  const { configured } = codexConfiguredCheck(undefined, noLapse);
  expect(configured(effortDefault, 140)).toBe(true);
  expect(configured(unpainted, 140)).toBe(false);
});

test("C-API-28 once Codex showed the requested effort a default label cannot revoke it", () => {
  const { configured } = codexConfiguredCheck("low", noLapse);
  expect(configured(effortDefault, 140)).toBe(false);
  expect(configured(effortLow, 140)).toBe(true);
  expect(configured(effortDefault, 140)).toBe(true);
  expect(configured(unpainted, 140)).toBe(false);
});

test("C-API-28 the backstop's delay after arming lets a footer that never shows the effort count", () => {
  vi.useFakeTimers();
  let lapses = 0;
  const check = codexConfiguredCheck("low", () => {
    lapses += 1;
    throw new Error("a throwing warning sink cannot hold readiness");
  });
  // Before the first frame arms it, no time counts toward the lapse.
  vi.advanceTimersByTime(55_000);
  expect(check.configured(effortDefault, 140)).toBe(false);
  check.arm();
  check.arm();
  vi.advanceTimersByTime(59_999);
  expect(check.configured(effortDefault, 140)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(check.configured(unpainted, 140)).toBe(false);
  expect(lapses).toBe(0);
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(check.configured(effortDefault, 140)).toBe(true);
  expect(lapses).toBe(1);
});

test("C-API-28 a stopped check never lapses", () => {
  vi.useFakeTimers();
  const check = codexConfiguredCheck("low", noLapse);
  check.arm();
  check.stop();
  check.arm();
  vi.advanceTimersByTime(120_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(check.configured(effortDefault, 140)).toBe(false);
});
