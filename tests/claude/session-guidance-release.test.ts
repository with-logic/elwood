/**
 * What ends a Claude `Stop` held for queued guidance, through a real session (PRD §6.5,
 * C-HOOK-24): Claude's idle composer, written guidance that never fires its hook, the turn a
 * superseded `Stop` leaves running, and a hang limit that cannot reopen a blocked session.
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  queuedTurnHangLimitMs,
  unheardInputLimitMs,
} from "../../src/claude/session/guidance/ledger.ts";
import {
  holdReasons,
  lastDecisionReason,
  paintTurnEnd,
  queuedTurnUnconfirmed,
  runningWithGuidance,
} from "./guidance-session-helpers.ts";
import { ptys, resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-HOOK-24 Claude's idle composer ends a held Stop whose queued turn never runs", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  const warnings: string[] = [];
  session.on("warning", (warning) => void warnings.push(warning.code));
  try {
    await submit("note");
    await stop("p1");
    expect(lastDecisionReason(session)).toBe(holdReasons.queued);
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
    expect(lastDecisionReason(session)).toBe(holdReasons.unheard);
    await expect
      .poll(() => session.status, { timeout: unheardInputLimitMs * 3, interval: 50 })
      .toBe("ready");
    expect(lastDecisionReason(session)).toBe(
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
    expect(lastDecisionReason(session)).toBe(holdReasons.queued);
    await stop("q2");
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 the hang limit releases a held Stop without reopening a blocked session", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  const warnings: unknown[] = [];
  session.on("warning", (warning) => void warnings.push(warning));
  try {
    await submit("note");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await stop("p1");
    ptys[0]!.emitData(
      "Do you want to create elwood.txt?\r\n ❯ 1. Yes\r\n   3. No\r\n Esc to cancel\r\n",
    );
    for (let step = 0; step < 40 && session.status !== "blocked"; step += 1)
      await vi.advanceTimersByTimeAsync(50);
    expect(session.status).toBe("blocked");
    vi.advanceTimersByTime(queuedTurnHangLimitMs);
    vi.useRealTimers();
    expect(session.status).toBe("blocked");
    expect(lastDecisionReason(session)).toBe(
      "ignored: hook_turn_ended must not reopen a blocked session",
    );
    await expect.poll(() => warnings).toEqual([queuedTurnUnconfirmed(session.elwoodSessionId)]);
  } finally {
    await session.stop();
  }
});
