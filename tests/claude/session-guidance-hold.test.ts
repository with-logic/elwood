/**
 * A Claude `Stop` held for guidance queued behind its turn, through a real session (PRD §6.5,
 * C-HOOK-24): the ignored decision it records, and what ends the hold.
 */
import { afterEach, expect, test, vi } from "vitest";
import { queuedTurnHangLimitMs } from "../../src/claude/session/guidance-ledger.ts";
import type { ClaudeHookEventFor, ClaudeHookResultForEvent } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, showComposer, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

type SubmitResult = ClaudeHookResultForEvent<ClaudeHookEventFor<"UserPromptSubmit">> | undefined;
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;
const heldReason = "ignored: Claude runs the guidance queued at this Stop as a new turn";

/** A session running prompt `p1`, with guidance `note` written into that turn. */
async function runningWithGuidance(screen?: () => Promise<SubmitResult>) {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { UserPromptSubmit: (event) => (event.prompt === "note" ? screen?.() : undefined) },
  });
  const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name,
      session_id: "claude-1",
      cwd,
      ...fields,
    });
  const submit = (prompt: string) => hook("UserPromptSubmit", { prompt_id: "p1", prompt });
  const stop = (promptId: string) => hook("Stop", { prompt_id: promptId, stop_hook_active: false });
  showComposer();
  await session.sendPrompt("busy");
  await submit("busy");
  await session.sendGuidance("note");
  return { session, hook, submit, stop };
}

const lastDecision = (session: { statusDecisions(): readonly { reason: string }[] }) =>
  session.statusDecisions().at(-1)?.reason;

test("C-HOOK-24 a Stop with allowed guidance queued waits for the queued turn's Stop", async () => {
  const { session, submit, stop } = await runningWithGuidance();
  try {
    await submit("note");
    await stop("p1");
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(heldReason);
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
  let answer: (result: SubmitResult) => void = () => undefined;
  const screening = new Promise<SubmitResult>((resolve) => {
    answer = resolve;
  });
  const { session, submit, stop } = await runningWithGuidance(() => screening);
  try {
    const screened = submit("note");
    await expect.poll(() => session.statusDecisions().length).toBeGreaterThan(0);
    await stop("p1");
    ptys[0]!.emitData(frame("esc to interrupt"));
    await session.terminal.settled();
    ptys[0]!.emitData(frame(claudeTty(claudeComposer)));
    await session.terminal.settled();
    expect(session.status).toBe("running");
    expect(lastDecision(session)).toBe(heldReason);
    answer({ decision: "block", reason: "Not now." });
    await screened;
    expect(session.status).toBe("ready");
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
    await expect.poll(() => warnings).toEqual(["queued_turn_unconfirmed"]);
  } finally {
    await session.stop();
  }
});
