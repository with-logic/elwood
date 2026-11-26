/**
 * The ledger of Claude guidance queued behind a running turn (PRD §6.5, C-HOOK-24): which
 * `Stop` it holds and why, and what ends that hold.
 */
import { describe, expect, test } from "vitest";
import {
  openGuidanceLedger,
  queuedTurnHangLimitMs,
  unheardInputLimitMs,
} from "../../src/claude/session/guidance/ledger.ts";
import { fakeClock, ledger, running } from "../helpers/guidance-ledger.ts";

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
    advance(unheardInputLimitMs - 500);
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
    advance(unheardInputLimitMs);
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

  test("a send after the turn ended starts a new turn, even under that turn's prompt ID", () => {
    const { subject } = running();
    expect(subject.holdStop("p1")).toBeUndefined();
    expect(subject.heard("p1")).toBeUndefined();
    subject.heard("p1")?.(false);
    expect(subject.holdStop("p1")).toBe("queued");
    expect(subject.holdRenderedEnd()).toBeUndefined();
    expect(subject.heard("p1")).toBeUndefined();
    expect(subject.holdStop("p1")).toBeUndefined();
  });

  test("a stale write never fires, so it cannot take the hook of a later write", () => {
    const { subject, advance } = running();
    subject.written();
    advance(unheardInputLimitMs);
    subject.written();
    subject.heard("p2");
    expect(subject.holdStop("p2")).toBeUndefined();
  });

  test("a ledger opened after the session closed holds nothing and starts no timer", () => {
    const { clock, pending } = fakeClock();
    const closing = new AbortController();
    closing.abort();
    const subject = openGuidanceLedger(closing.signal, () => undefined, clock);
    subject.heard("p1");
    subject.written();
    expect(subject.holdStop("p1")).toBeUndefined();
    expect(pending()).toBe(0);
  });
});
