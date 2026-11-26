/**
 * A Claude guidance ledger on a hand-advanced clock, for the ledger's unit tests (PRD §6.5,
 * C-HOOK-24).
 */
import {
  ClaudeGuidanceLedger,
  type GuidanceRelease,
} from "../../src/claude/session/guidance/ledger.ts";
import type { DeadlineClock } from "../../src/core/timers.ts";

export function fakeClock() {
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

export function ledger() {
  const releases: GuidanceRelease[] = [];
  const time = fakeClock();
  const subject = new ClaudeGuidanceLedger((cause) => void releases.push(cause), time.clock);
  return { subject, releases, ...time };
}

/** A turn `p1` whose own prompt Claude submitted. */
export function running() {
  const fixture = ledger();
  fixture.subject.heard("p1");
  return fixture;
}
