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
  const check = codexConfiguredCheck(undefined, noLapse);
  expect(check(effortDefault, 140)).toBe(true);
  expect(check(unpainted, 140)).toBe(false);
});

test("C-API-28 once Codex showed the requested effort a default label cannot revoke it", () => {
  const check = codexConfiguredCheck("low", noLapse);
  expect(check(effortDefault, 140)).toBe(false);
  expect(check(effortLow, 140)).toBe(true);
  expect(check(effortDefault, 140)).toBe(true);
  expect(check(unpainted, 140)).toBe(false);
});

test("C-API-28 by the backstop a footer that never shows the effort counts, with a warning", () => {
  vi.useFakeTimers();
  let lapses = 0;
  const check = codexConfiguredCheck("low", () => {
    lapses += 1;
    throw new Error("a throwing warning sink cannot hold readiness");
  });
  vi.advanceTimersByTime(59_999);
  expect(check(effortDefault, 140)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(check(unpainted, 140)).toBe(false);
  expect(lapses).toBe(0);
  expect(check(effortDefault, 140)).toBe(true);
  expect(check(effortDefault, 140)).toBe(true);
  expect(lapses).toBe(1);
});
