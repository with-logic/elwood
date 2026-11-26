/**
 * A Claude `Stop` held for guidance queued behind its turn, through a real session (PRD §6.5,
 * C-HOOK-24): the ignored decision it records, and what it waits on.
 */
import { afterEach, expect, test, vi } from "vitest";
import { queuedTurnHangLimitMs } from "../../src/claude/session/guidance/ledger.ts";
import {
  holdReasons,
  lastDecisionReason,
  paintTurnEnd,
  queuedTurnUnconfirmed,
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
    expect(lastDecisionReason(session)).toBe(holdReasons.queued);
    await stop("q1");
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});

const bash = { command: "true" };
const toolHooks = {
  PostToolUse: { tool_name: "Bash", tool_input: bash, tool_response: {}, tool_use_id: "t1" },
  PostToolUseFailure: { tool_name: "Bash", tool_input: bash, error: "exit 1", tool_use_id: "t1" },
  PostToolBatch: { tool_calls: [] },
};

test.each(
  Object.entries(toolHooks),
)("C-HOOK-24 guidance a %s boundary delivered holds no Stop", async (name, fields) => {
  const { session, hook, submit, stop } = await runningWithGuidance();
  try {
    await submit("note");
    await hook(name, { prompt_id: "p1", ...fields });
    await stop("p1");
    expect(session.status).toBe("ready");
    expect(lastDecisionReason(session)).toBe("applied: running became ready");
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 a screening handler that times out allows the guidance it held", async () => {
  let entered: () => void = () => undefined;
  const handlerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { session, submit, stop } = await runningWithGuidance({
    hookTimeoutMs: 300,
    screen: () => {
      entered();
      return new Promise<SubmitResult>(() => undefined);
    },
  });
  try {
    const screened = submit("note");
    await handlerEntered;
    await stop("p1");
    expect(lastDecisionReason(session)).toBe(holdReasons.screening);
    await screened;
    expect(session.status).toBe("running");
    await stop("q1");
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
    expect(lastDecisionReason(session)).toBe(holdReasons.screening);
    await paintTurnEnd(session);
    expect(session.status).toBe("running");
    expect(lastDecisionReason(session)).toBe(holdReasons.screening);
    answer({ decision: "block", reason: "Not now." });
    await screened;
    expect(session.status).toBe("ready");
    expect(lastDecisionReason(session)).toBe(
      "applied: running became ready; the guidance held at the Stop was blocked",
    );
  } finally {
    await session.stop();
  }
});

test("C-HOOK-24 a held Stop with no queued turn ends at the hang limit with a warning", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  const warnings: unknown[] = [];
  session.on("warning", (warning) => void warnings.push(warning));
  try {
    await submit("note");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await stop("p1");
    expect(session.status).toBe("running");
    vi.advanceTimersByTime(queuedTurnHangLimitMs);
    vi.useRealTimers();
    expect(session.status).toBe("ready");
    expect(lastDecisionReason(session)).toBe(
      "applied: running became ready; no queued turn ended within the hang limit",
    );
    await expect.poll(() => warnings).toEqual([queuedTurnUnconfirmed(session.elwoodSessionId)]);
  } finally {
    await session.stop();
  }
});
