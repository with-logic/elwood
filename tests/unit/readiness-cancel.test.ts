/** Exit cancellation cannot be undone by late terminal rendering (PRD §9.4, C-PERF-05). */

import { afterEach, expect, test, vi } from "vitest";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";

afterEach(() => vi.useRealTimers());

test("C-PERF-05 a drained resume frame after exit cannot arm a deadline or submit readiness", () => {
  vi.useFakeTimers();
  const onReady = vi.fn();
  const gate = createReadinessGate(onReady, true);
  gate.ready.cancel();
  gate.ready.armDeadline();
  gate.observeReadinessFrame({ composer_visible: true, blocking_prompt_visible: false });
  gate.ready.replay();
  expect(vi.getTimerCount()).toBe(0);
  expect(onReady).not.toHaveBeenCalled();
});

test("C-PERF-05 cancellation suppresses deferred readiness and already-ready replay", () => {
  vi.useFakeTimers();
  const onReady = vi.fn();
  const ready = initialReady(onReady);
  ready.mark();
  ready.cancel();
  ready.replay();
  ready.armDeadline();
  expect(onReady).toHaveBeenCalledOnce();
  const blocked = initialReady(onReady, 10_000, () => true);
  blocked.mark();
  blocked.cancel();
  blocked.retryWhenUnblocked(false);
  expect(onReady).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
