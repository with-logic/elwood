/**
 * The ledger of Claude guidance queued behind a running turn (PRD §6.5, C-HOOK-24): which
 * `Stop` it holds and why, and what ends that hold.
 */
import { describe, expect, test } from "vitest";
import {
  ClaudeGuidanceLedger,
  type GuidanceRelease,
  queuedTurnHangLimitMs,
  unheardGuidanceLimitMs,
} from "../../src/claude/session/guidance/ledger.ts";
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
  const releases: GuidanceRelease[] = [];
  const time = fakeClock();
  const subject = new ClaudeGuidanceLedger((cause) => void releases.push(cause), time.clock);
  return { subject, releases, ...time };
}

/** A turn `p1` whose own prompt Claude submitted. */
function running() {
  const fixture = ledger();
  fixture.subject.heard("p1");
  return fixture;
}

describe("C-HOOK-24 Claude guidance ledger", () => {
  test("a turn's own prompt is not guidance, and its Stop with nothing queued is not held", () => {
    const { subject } = ledger();
    expect(subject.heard("p1")).toBeUndefined();
    expect(subject.holdStop("p1")).toBeUndefined();
    expect(subject.holdRenderedEnd()).toBeUndefined();
  });

  test("allowed guidance holds the Stop until the next Stop, the queued turn's", () => {
    const { subject, releases } = running();
    subject.heard("p1")?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    expect(subject.holdStop("p1")).toBeUndefined();
    expect(releases).toEqual([]);
  });

  test("guidance a tool boundary delivered inside the turn holds nothing", () => {
    const { subject } = running();
    subject.heard("p1")?.(false);
    subject.toolBoundary();
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("blocked guidance holds nothing, and the last block after the Stop releases it", () => {
    const { subject, releases } = running();
    subject.heard("p1")?.(true);
    expect(subject.holdStop("p1")).toBeUndefined();
    const first = subject.heard("p1");
    const second = subject.heard("p1");
    expect(subject.holdStop("p1")).toBe("screening");
    first?.(true);
    expect(releases).toEqual([]);
    second?.(true);
    expect(releases).toEqual(["blocked"]);
    expect(subject.holdRenderedEnd()).toBeUndefined();
  });

  test("the idle composer cannot end a held turn while a handler screens", () => {
    const { subject, releases } = running();
    const answer = subject.heard("p1");
    expect(subject.holdStop("p1")).toBe("screening");
    expect(subject.holdRenderedEnd()).toBe("screening");
    answer?.(false);
    expect(releases).toEqual([]);
    expect(subject.holdRenderedEnd()).toBeUndefined();
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("the first allow after a screening Stop starts the queued turn; later ones wait behind it", () => {
    const { subject } = running();
    const first = subject.heard("p1");
    const second = subject.heard("p1");
    expect(subject.holdStop("p1")).toBe("screening");
    first?.(false);
    second?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("guidance sent during the queued turn holds that turn's Stop, unless it is blocked", () => {
    const { subject, releases } = running();
    subject.heard("p1")?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    subject.heard("q1")?.(true);
    expect(releases).toEqual([]);
    subject.heard("q1")?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("guidance Elwood wrote holds the Stop until its hook, or until the limit", () => {
    const { subject, releases, advance } = running();
    subject.written();
    advance(500);
    subject.written();
    expect(subject.holdStop("p1")).toBe("unheard");
    expect(subject.holdRenderedEnd()).toBe("unheard");
    advance(unheardGuidanceLimitMs - 500);
    expect(releases).toEqual([]);
    advance(500);
    expect(releases).toEqual(["unheard"]);
  });

  test("a hook for written guidance ends its wait, and a stale write holds nothing", () => {
    const { subject, advance } = running();
    subject.written();
    subject.heard("p1")?.(false);
    subject.toolBoundary();
    expect(subject.holdStop("p1")).toBeUndefined();
    subject.written();
    advance(unheardGuidanceLimitMs);
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("a held Stop with no queued turn's Stop or idle composer ends at the hang limit", () => {
    const { subject, releases, advance, pending } = running();
    subject.heard("p1")?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    advance(queuedTurnHangLimitMs);
    expect(releases).toEqual(["hung"]);
    expect(pending()).toBe(0);
  });

  test("a submit or Stop without a prompt ID is never held", () => {
    const { subject } = running();
    expect(subject.heard(undefined)).toBeUndefined();
    subject.heard("p1")?.(false);
    expect(subject.holdStop(undefined)).toBeUndefined();
  });

  test("a message an interrupt re-fires as its own turn is no longer queued", () => {
    const { subject } = running();
    subject.heard("p1")?.(false);
    expect(subject.heard("p2")).toBeUndefined();
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("closing the session stops every timer, and a later Stop holds nothing", () => {
    const { subject, pending } = running();
    subject.written();
    expect(subject.holdStop("p1")).toBe("unheard");
    expect(pending()).toBe(2);
    subject.dispose();
    expect(pending()).toBe(0);
    subject.heard("p1")?.(false);
    subject.written();
    expect(subject.holdStop("p1")).toBeUndefined();
    expect(pending()).toBe(0);
  });
});
