/**
 * What ends a Claude `Stop` held for queued guidance, through a real session (PRD §6.5,
 * C-HOOK-24): Claude's idle composer, written guidance that never fires its hook, and the turn
 * a superseded `Stop` leaves running.
 */
import { afterEach, expect, test } from "vitest";
import { unheardGuidanceLimitMs } from "../../src/claude/session/guidance/ledger.ts";
import {
  holdReasons,
  lastDecision,
  paintTurnEnd,
  runningWithGuidance,
} from "./guidance-session-helpers.ts";
import { resetFakes } from "./helpers.ts";

afterEach(() => {
  resetFakes();
});

test("C-HOOK-24 Claude's idle composer ends a held Stop whose queued turn never runs", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  const warnings: string[] = [];
  session.on("warning", (warning) => void warnings.push(warning.code));
  try {
    await submit("note");
    await stop("p1");
    expect(lastDecision(session)).toBe(holdReasons.queued);
    await paintTurnEnd(session);
    expect(session.status).toBe("ready");
    expect(session.statusDecisions().at(-1)).toMatchObject({
      evidence: "rendered_turn_ended",
      to: "ready",
    });
    expect(warnings).toEqual([]);
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 written guidance that never fires its hook holds the Stop for its limit", async () => {
  const { session, stop } = await runningWithGuidance();
  const warnings: string[] = [];
  session.on("warning", (warning) => void warnings.push(warning.code));
  try {
    await stop("p1");
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(holdReasons.unheard);
    await expect
      .poll(() => session.status, { timeout: unheardGuidanceLimitMs * 3, interval: 50 })
      .toBe("ready");
    expect(lastDecision(session)).toBe(
      "applied: running became ready; input written into the turn never fired its UserPromptSubmit",
    );
    expect(warnings).toEqual([]);
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 a superseded Stop records nothing, and the turn it leaves still holds", async () => {
  let entered: () => void = () => undefined;
  const stopEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish: () => void = () => undefined;
  const stopGate = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const { session, submit, stop } = await runningWithGuidance({
    stop: () => {
      entered();
      return stopGate;
    },
  });
  try {
    await submit("note");
    const stopping = stop("p1");
    await stopEntered;
    await session.sendGuidance("more");
    const before = session.statusDecisions().length;
    finish();
    await stopping;
    expect(session.status).toBe("running");
    expect(session.statusDecisions().slice(before)).toEqual([]);
    await submit("more");
    await stop("q1");
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(holdReasons.queued);
    await stop("q2");
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});
