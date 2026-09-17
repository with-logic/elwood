/**
 * Unit tests for Codex hook-backed initial readiness.
 * Covers PRD §5.3, C-API-19, and C-API-28.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  initialReady,
  markReadyOnResumeComposer,
} from "../../src/runtime/readiness/initial-ready.ts";

afterEach(() => vi.useRealTimers());

describe("initialReady", () => {
  test("C-API-28 mark fires readiness once and replays after a session is attached", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    // The SessionStart hook path: mark() releases the first queued message.
    ready.mark();
    ready.mark();
    expect(calls).toBe(1);
    ready.replay();
    expect(calls).toBe(2);
  });

  test("C-API-28 the deadline is the fallback when the readiness hook never arrives", () => {
    vi.useFakeTimers();
    let calls = 0;
    const ready = initialReady(() => calls++, 20);
    ready.armDeadline();
    ready.armDeadline();
    vi.advanceTimersByTime(50);
    expect(calls).toBe(1);
  });

  test("C-API-28 a real SessionStart wins over the pending deadline", () => {
    vi.useFakeTimers();
    let calls = 0;
    const ready = initialReady(() => calls++, 100);
    ready.armDeadline();
    ready.mark();
    vi.advanceTimersByTime(150);
    // mark fired once; the later deadline is a no-op because readiness latched.
    expect(calls).toBe(1);
  });

  test("C-API-28 cancel clears the pending starvation deadline", () => {
    vi.useFakeTimers();
    let calls = 0;
    const ready = initialReady(() => calls++, 20);
    ready.armDeadline();
    ready.cancel();
    vi.advanceTimersByTime(50);
    expect(calls).toBe(0);
  });

  test("replay before readiness does nothing", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    ready.replay();
    expect(calls).toBe(0);
  });

  const facts = (composer_visible: boolean, blocking_prompt_visible = false) => ({
    composer_visible,
    blocking_prompt_visible,
  });

  test("C-API-28 on RESUME the first visible composer marks readiness", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    markReadyOnResumeComposer(ready, true, facts(false)); // composer not up yet: no-op
    expect(calls).toBe(0);
    markReadyOnResumeComposer(ready, true, facts(true)); // composer visible on resume: ready
    markReadyOnResumeComposer(ready, true, facts(true)); // idempotent
    expect(calls).toBe(1);
  });

  test("C-API-28 on RESUME a blocking dialog's caret does NOT mark readiness", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    // The dialog option caret is byte-identical to the composer marker, so composer AND
    // blocking are both visible: readiness must wait, or a queued Enter could approve it.
    markReadyOnResumeComposer(ready, true, facts(true, true));
    expect(calls).toBe(0);
  });

  test("C-API-28 on a COLD start the composer never marks readiness (would be swallowed)", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    markReadyOnResumeComposer(ready, false, facts(true)); // not resumed: composer is unsafe
    expect(calls).toBe(0);
  });

  test("C-API-28 a resume-composer readiness wins over the pending deadline", () => {
    vi.useFakeTimers();
    let calls = 0;
    const ready = initialReady(() => calls++, 100);
    ready.armDeadline();
    markReadyOnResumeComposer(ready, true, facts(true));
    vi.advanceTimersByTime(150);
    expect(calls).toBe(1); // fired once on the composer; the later deadline is a no-op
  });

  test("C-API-28 a throwing readiness callback does NOT latch — a later attempt retries", () => {
    let calls = 0;
    let failFirst = true;
    const ready = initialReady(() => {
      calls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error("listener boom");
      }
    });
    // First mark throws (a throwing readiness-transition listener): readiness must NOT
    // be consumed, so a later attempt can still fire it.
    expect(() => ready.mark()).toThrow(/listener boom/);
    // A later attempt (hook/deadline/frame) retries and succeeds — the queue is never
    // permanently starved by one failed transition.
    ready.mark();
    expect(calls).toBe(2);
  });

  test("C-API-28 a mark while a dialog is up defers — it fires only once the dialog clears", () => {
    // A blocking dialog rendered during `starting` never latches `blocked`, so a
    // hook/deadline mark must NOT drain the queue INTO it; the mark is deferred and
    // reconciled by retryWhenUnblocked once the dialog clears — never starved.
    let calls = 0;
    let blocked = true;
    const ready = initialReady(
      () => calls++,
      10_000,
      () => blocked,
    );
    ready.mark(); // the SessionStart hook fires while the dialog is on screen
    expect(calls).toBe(0); // deferred, not drained into the dialog
    ready.retryWhenUnblocked(true); // a redraw, still blocked
    expect(calls).toBe(0);
    blocked = false;
    ready.retryWhenUnblocked(false); // the dialog cleared
    expect(calls).toBe(1); // the deferred readiness fires now
    ready.retryWhenUnblocked(false);
    expect(calls).toBe(1); // idempotent
  });

  test("C-API-28 retryWhenUnblocked is a no-op when no mark was deferred", () => {
    // A clear frame with no pending deferred mark must not fabricate readiness.
    let calls = 0;
    const ready = initialReady(() => calls++);
    ready.retryWhenUnblocked(false);
    expect(calls).toBe(0);
  });
});

test("C-TRUST-01 cancelled readiness cannot rearm, replay, or consume a late hook", () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const ready = initialReady(callback);
  ready.cancel();
  ready.mark();
  ready.armDeadline();
  ready.replay();
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const completed = initialReady(callback);
  completed.mark();
  completed.cancel();
  completed.replay();
  expect(callback).toHaveBeenCalledTimes(1);
});
