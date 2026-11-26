/**
 * The ledger of Claude guidance queued behind a running turn (PRD §6.5, C-HOOK-24): which
 * `Stop` it holds, and what ends that hold.
 */
import { describe, expect, test } from "vitest";
import {
  ClaudeGuidanceLedger,
  queuedTurnHangLimitMs,
  unheardGuidanceLimitMs,
} from "../../src/claude/session/guidance-ledger.ts";
import type { DeadlineClock } from "../../src/core/timers.ts";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const clock: DeadlineClock = {
    now: () => now,
    setTimer: (run, delayMs) => {
      next += 1;
      timers.set(next, { at: now + delayMs, run });
      return next;
    },
    clearTimer: (timer) => void timers.delete(timer as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now || !timers.has(id)) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function ledger() {
  const releases: boolean[] = [];
  const time = fakeClock();
  const subject = new ClaudeGuidanceLedger((hung) => void releases.push(hung), time.clock);
  return { subject, releases, ...time };
}

/** A turn `p1` whose own prompt Claude submitted. */
function running() {
  const fixture = ledger();
  expect(fixture.subject.heard("p1")).toBeUndefined();
  return fixture;
}

describe("C-HOOK-24 Claude guidance ledger", () => {
  test("a Stop with nothing queued behind its turn is not held", () => {
    const { subject } = running();
    expect(subject.stopHolds("p1")).toBe(false);
    expect(subject.renderedEndReleases()).toBe(true);
  });

  test("allowed guidance holds the Stop until the queued turn's own Stop", () => {
    const { subject, releases } = running();
    subject.heard("p1")?.(false);
    expect(subject.stopHolds("p1")).toBe(true);
    expect(subject.stopHolds("p1")).toBe(true);
    expect(subject.stopHolds("q1")).toBe(false);
    expect(releases).toEqual([]);
  });

  test("guidance a tool boundary delivered inside the turn holds nothing", () => {
    const { subject } = running();
    subject.heard("p1")?.(false);
    subject.toolBoundary();
    expect(subject.stopHolds("p1")).toBe(false);
  });

  test("blocked guidance holds nothing, and a block after the Stop releases it", () => {
    const { subject, releases } = running();
    subject.heard("p1")?.(true);
    expect(subject.stopHolds("p1")).toBe(false);
    const answer = subject.heard("p1");
    expect(subject.stopHolds("p1")).toBe(true);
    answer?.(true);
    expect(releases).toEqual([false]);
    expect(subject.renderedEndReleases()).toBe(true);
  });

  test("the idle composer cannot end a held turn while a handler screens", () => {
    const { subject, releases } = running();
    const answer = subject.heard("p1");
    expect(subject.stopHolds("p1")).toBe(true);
    expect(subject.renderedEndReleases()).toBe(false);
    answer?.(false);
    expect(releases).toEqual([]);
    expect(subject.renderedEndReleases()).toBe(true);
    expect(subject.stopHolds("q1")).toBe(false);
  });

  test("the first allow after a screening Stop starts the queued turn; later ones wait behind it", () => {
    const { subject } = running();
    const first = subject.heard("p1");
    const second = subject.heard("p1");
    expect(subject.stopHolds("p1")).toBe(true);
    first?.(false);
    second?.(false);
    expect(subject.stopHolds("q1")).toBe(true);
    expect(subject.stopHolds("q2")).toBe(false);
  });

  test("guidance sent during the queued turn holds that turn's Stop too", () => {
    const { subject } = running();
    subject.heard("p1")?.(false);
    expect(subject.stopHolds("p1")).toBe(true);
    subject.heard("q1")?.(false);
    expect(subject.stopHolds("q1")).toBe(true);
    expect(subject.stopHolds("q2")).toBe(false);
  });

  test("guidance Elwood wrote holds the Stop until its hook, or until the limit", () => {
    const { subject, releases, advance } = running();
    subject.written();
    advance(500);
    subject.written();
    expect(subject.stopHolds("p1")).toBe(true);
    expect(subject.renderedEndReleases()).toBe(false);
    advance(unheardGuidanceLimitMs - 500);
    expect(releases).toEqual([]);
    advance(500);
    expect(releases).toEqual([false]);
  });

  test("a hook for written guidance ends its wait, and a stale write holds nothing", () => {
    const { subject, advance } = running();
    subject.written();
    subject.heard("p1")?.(false);
    subject.toolBoundary();
    expect(subject.stopHolds("p1")).toBe(false);
    subject.written();
    advance(unheardGuidanceLimitMs);
    expect(subject.stopHolds("p1")).toBe(false);
  });

  test("a held Stop with no queued turn's Stop or idle composer ends at the hang limit", () => {
    const { subject, releases, advance, pending } = running();
    subject.heard("p1")?.(false);
    expect(subject.stopHolds("p1")).toBe(true);
    advance(queuedTurnHangLimitMs);
    expect(releases).toEqual([true]);
    expect(pending()).toBe(0);
  });

  test("a submit or Stop without a prompt ID is never held", () => {
    const { subject } = running();
    expect(subject.heard(undefined)).toBeUndefined();
    subject.heard("p1")?.(false);
    expect(subject.stopHolds(undefined)).toBe(false);
  });

  test("a message an interrupt re-fires as its own turn is no longer queued", () => {
    const { subject } = running();
    subject.heard("p1")?.(false);
    expect(subject.heard("p2")).toBeUndefined();
    expect(subject.stopHolds("p2")).toBe(false);
  });

  test("closing the session stops every timer", () => {
    const { subject, pending } = running();
    subject.written();
    expect(subject.stopHolds("p1")).toBe(true);
    expect(pending()).toBe(2);
    subject.dispose();
    expect(pending()).toBe(0);
  });
});
