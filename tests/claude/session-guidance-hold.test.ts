/**
 * A Claude `Stop` held for guidance queued behind its turn, through a real session (PRD §6.5,
 * C-HOOK-24): the ignored decision it records, and what it waits on.
 */
import { afterEach, expect, test, vi } from "vitest";
import { queuedTurnHangLimitMs } from "../../src/claude/session/guidance/ledger.ts";
import {
  holdReasons,
  lastDecision,
  paintTurnEnd,
  runningWithGuidance,
  type SubmitResult,
} from "./guidance-session-helpers.ts";
import { resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-HOOK-24 a Stop with allowed guidance queued waits for the queued turn's Stop", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  try {
    await submit("note");
    await stop("p1");
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(holdReasons.queued);
    await stop("q1");
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 guidance a tool boundary delivered holds no Stop", async () => {
  const { session, hook, submit, stop } = await runningWithGuidance();
  try {
    await submit("note");
    await hook("PostToolBatch", { prompt_id: "p1", tool_calls: [] });
    await stop("p1");
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 the idle composer cannot end the turn while a handler screens guidance", async () => {
  let entered: () => void = () => undefined;
  const handlerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let answer: (result: SubmitResult) => void = () => undefined;
  const screening = new Promise<SubmitResult>((resolve) => {
    answer = resolve;
  });
  const { session, submit, stop } = await runningWithGuidance({
    screen: () => {
      entered();
      return screening;
    },
  });
  try {
    const screened = submit("note");
    await handlerEntered;
    await stop("p1");
    expect(lastDecision(session)).toBe(holdReasons.screening);
    await paintTurnEnd(session);
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(holdReasons.screening);
    answer({ decision: "block", reason: "Not now." });
    await screened;
    expect(session.status).toBe("ready");
    expect(lastDecision(session)).toBe(
      "applied: running became ready; the guidance held at the Stop was blocked",
    );
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 a held Stop with no queued turn ends at the hang limit with a warning", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  const warnings: string[] = [];
  session.on("warning", (warning) => void warnings.push(warning.code));
  try {
    await submit("note");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await stop("p1");
    expect(session.status).toBe("running");
    vi.advanceTimersByTime(queuedTurnHangLimitMs);
    vi.useRealTimers();
    expect(session.status).toBe("ready");
    expect(lastDecision(session)).toBe(
      "applied: running became ready; no queued turn ended within the hang limit",
    );
    await expect.poll(() => warnings).toEqual(["queued_turn_unconfirmed"]);
  } finally {
    await session.stop();
  }
});
