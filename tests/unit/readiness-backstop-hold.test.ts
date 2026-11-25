/** Backstop holds survive unknown resume frames and observer failures (PRD §5.3, C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";

afterEach(() => vi.useRealTimers());

test("C-API-28 a resume caret cannot release the backstop hold without configured evidence", () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const warning = vi.fn();
  const gate = createReadinessGate(callback, true, {
    configured: (frame) => frame === "configured composer",
    onBackstop: warning,
  });
  gate.observeReadinessFrame(
    { composer_visible: false, blocking_prompt_visible: false },
    false,
    "loading",
  );
  gate.ready.armDeadline();
  vi.advanceTimersByTime(60_000);
  expect(warning).toHaveBeenCalledOnce();
  expect(gate.holdsReadiness()).toBe(true);
  const idle = { composer_visible: true, blocking_prompt_visible: false };
  gate.observeReadinessFrame(idle, false, "unidentified caret");
  expect(callback).not.toHaveBeenCalled();
  expect(gate.holdsReadiness()).toBe(true);
  gate.observeReadinessFrame(idle, false, "configured composer");
  expect(callback).toHaveBeenCalledOnce();
  expect(gate.holdsReadiness()).toBe(false);
});

test("C-API-28 a throwing Claude readiness observer remains retryable after the backstop", () => {
  vi.useFakeTimers();
  let fail = true;
  const callback = vi.fn(() => {
    if (fail) throw new Error("observer failed");
  });
  const ready = initialReady(callback);
  ready.armDeadline();
  expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  expect(callback).toHaveBeenCalledTimes(2);
  fail = false;
  ready.mark();
  expect(callback).toHaveBeenCalledTimes(3);
});

test("C-API-28 the backstop does not re-hold writes once a configured composer was seen", () => {
  vi.useFakeTimers();
  const gate = createReadinessGate(() => {}, false, {
    configured: (frame) => frame === "configured composer",
    onBackstop: () => {},
  });
  const idle = { composer_visible: true, blocking_prompt_visible: false };
  gate.observeReadinessFrame(idle, false, "configured composer");
  expect(gate.holdsWrites()).toBe(false);
  // The write's own draft is no configured composer, so the deadline cannot mark onto it.
  gate.observeReadinessFrame(idle, false, "draft");
  gate.ready.armDeadline();
  vi.advanceTimersByTime(60_000);
  expect(gate.holdsReadiness()).toBe(true);
  expect(gate.holdsWrites()).toBe(false);
  gate.ready.cancel();
});
