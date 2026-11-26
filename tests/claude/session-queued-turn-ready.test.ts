/**
 * Claude readiness while queued messages become new turns, through authenticated bridge hooks and
 * a real transcript watcher (PRD §6.5, C-HOOK-24).
 */
import { afterEach, expect, test, vi } from "vitest";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { resetFakes } from "./helpers.ts";
import {
  dequeue,
  pastBound,
  queuedUser,
  stopWithQueuedMessage,
  turnEnds,
} from "./session-queued-turn-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});
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
  pty.emitData(claudeWorking);
  await vi.advanceTimersByTimeAsync(20);
  pty.emitData(claudeIdle);
  await vi.advanceTimersByTimeAsync(20);
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

test("C-HOOK-24 the bound ends no turn that raw input or a later allowed submit may have started", async () => {
  const typed = await stopWithQueuedMessage();
  const keys = typed.session.sendKeys("x");
  await vi.advanceTimersByTimeAsync(20);
  await keys;
  await pastBound();
  // A listener of the Stop itself writes raw input before Elwood decides how that Stop ends.
  const heard = await stopWithQueuedMessage({
    onStop: (session) =>
      session.on("hook", (event) => {
        if (event.hook_event_name === "Stop") void session.sendKeys("x");
      }),
  });
  await pastBound();
  const submitted = await stopWithQueuedMessage();
  await submitted.submit("typed at the terminal", "turn-typed");
  await pastBound();
  for (const { session, warnings } of [typed, heard, submitted]) {
    expect(session.status).toBe("running");
    expect(turnEnds(session)).toEqual([]);
    expect(warnings).toEqual([]);
  }
});

test.each([
  ["allows it, and Claude then runs it", undefined, []],
  [
    "blocks it, so Claude runs none",
    { decision: "block" as const, reason: "No." },
    ["hook_turn_ended"],
  ],
])("C-HOOK-24 a handler still screening at the Stop holds readiness until it %s", async (_, answer, ends) => {
  let screened: (result: typeof answer) => void = () => {};
  const hooks = {
    UserPromptSubmit: (event: { prompt: string }) =>
      event.prompt === "note"
        ? new Promise<typeof answer>((resolve) => (screened = resolve))
        : undefined,
  };
  const { session, pty, append, stop, warnings, note } = await stopWithQueuedMessage({
    options: { hooks },
    screening: true,
  });
  // Claude idles while the handler screens: that idle composer is not the turn's end.
  pty.emitData(claudeIdle);
  await vi.advanceTimersByTimeAsync(20);
  await pastBound();
  await pastBound();
  expect(session.status).toBe("running");
  screened(answer);
  await note; // the handler's answer reached Claude before its queued records or next Stop
  await vi.advanceTimersByTimeAsync(100);
  if (answer === undefined) {
    append(dequeue, queuedUser("turn-2", "note"));
    await pastBound();
    expect(session.status).toBe("running");
    await stop("turn-2");
  }
  expect(session.status).toBe("ready");
  expect(turnEnds(session)).toEqual(answer === undefined ? ["hook_turn_ended"] : ends);
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
