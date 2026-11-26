/**
 * Claude readiness while queued messages become new turns, through authenticated bridge hooks and
 * a real transcript watcher (PRD §6.5, C-HOOK-24).
 */
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { queuedTurnStartLimitMs } from "../../src/claude/session/queued-turn.ts";
import type { ClaudeSessionApi, ElwoodWarningEvent, StartClaudeOptions } from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { resetFakes } from "./helpers.ts";
import { startPromptActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
const dequeue = { type: "queue-operation", operation: "dequeue" };
const queuedUser = (promptId: string, text: string) => ({
  ...user(promptId, text),
  promptSource: "queued",
});
const pastBound = () => vi.advanceTimersByTimeAsync(queuedTurnStartLimitMs + 100);

type QueuedStop = {
  readonly onStop?: (session: ClaudeSessionApi) => void;
  readonly options?: Omit<StartClaudeOptions, "cwd">;
};

async function stopWithQueuedMessage({ onStop, options }: QueuedStop = {}) {
  // Only the test advances the watcher's background poll; the session starts on real timeouts.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const activity = await startPromptActivitySession(options);
  onTestFinished(() => activity.session.teardown());
  const { session, submit, append } = activity;
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => void warnings.push(warning));
  await session.sendPrompt("essay");
  await submit("essay", "turn-1");
  append(user("turn-1", "essay"));
  // Claude screens a message queued during the turn under the running turn's prompt ID.
  await submit("note", "turn-1");
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  onStop?.(session);
  const stop = (prompt_id: string) =>
    activity.hook({ hook_event_name: "Stop", prompt_id, stop_hook_active: false });
  await stop("turn-1");
  return { ...activity, warnings, stop };
}

const turnEnds = (session: ClaudeSessionApi) =>
  session
    .statusDecisions()
    .filter((decision) => decision.evidence.endsWith("_ended") && decision.to === "ready")
    .map((decision) => decision.evidence);

test("C-HOOK-24 queued turns keep the session running until the last one stops", async () => {
  const { session, submit, append, stop, warnings } = await stopWithQueuedMessage();
  expect(session.status).toBe("running");
  append(dequeue, queuedUser("turn-2", "note"));
  await vi.advanceTimersByTimeAsync(100);
  // A message queued during the queued turn reuses that turn's ID, which its record named.
  await submit("second note", "turn-2");
  await stop("turn-2");
  expect(session.status).toBe("running");
  append(dequeue, queuedUser("turn-3", "second note"));
  await pastBound();
  expect(session.status).toBe("running");
  await stop("turn-3");
  expect(session.status).toBe("ready");
  expect(warnings).toEqual([]);
});

test("C-HOOK-24 a queued message Claude never starts warns and releases readiness at the bound", async () => {
  const { session, warnings } = await stopWithQueuedMessage();
  expect(session.status).toBe("running");
  await pastBound();
  expect(session.status).toBe("ready");
  expect(warnings).toEqual([expect.objectContaining({ code: "queued_turn_unconfirmed" })]);
});

test("C-HOOK-24 a queued message the caller blocked holds no Stop", async () => {
  const block = { decision: "block" as const, reason: "Blocked by policy." };
  const hooks = {
    UserPromptSubmit: (event: { prompt: string }) => (event.prompt === "note" ? block : undefined),
  };
  const { session, warnings } = await stopWithQueuedMessage({ options: { hooks } });
  expect(session.status).toBe("ready");
  expect(turnEnds(session)).toEqual(["hook_turn_ended"]);
  await pastBound();
  expect(warnings).toEqual([]);
});

test("C-HOOK-24 the bound ends no turn the screen ended, nor a turn started since", async () => {
  const { session, pty, warnings } = await stopWithQueuedMessage();
  for (const frame of [claudeWorking, claudeIdle]) {
    pty.emitData(frame);
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(session.status).toBe("ready");
  // Raw input started a turn after the screen ended the Stop's turn.
  pty.emitData(claudeWorking);
  await vi.advanceTimersByTimeAsync(20);
  expect(session.status).toBe("running");
  await pastBound();
  expect(session.status).toBe("running");
  expect(turnEnds(session)).toEqual(["rendered_turn_ended"]);
  expect(warnings).toEqual([]);
});

test("C-HOOK-22 C-HOOK-24 the hold reports listener failures in the Stop's one warning", async () => {
  const lateReply = { type: "assistant", message: { content: [{ type: "text", text: "late" }] } };
  const fail = () => {
    throw new Error("private listener failure");
  };
  // Only the hold's scan, which delivers a late reply, fails: the Stop's warning reports it.
  const late = await stopWithQueuedMessage();
  late.session.on("activity", fail);
  late.append(lateReply);
  await vi.advanceTimersByTimeAsync(60);
  expect(late.warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "transcript" }),
  ]);
  // The Stop's own hook activity fails first; the hold's later failure adds no second warning.
  const both = await stopWithQueuedMessage({ onStop: (session) => session.on("activity", fail) });
  both.append(lateReply);
  await vi.advanceTimersByTimeAsync(60);
  expect(both.warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "activity" }),
  ]);
});
