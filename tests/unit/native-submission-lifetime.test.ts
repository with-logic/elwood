/** Missing native evidence and nested synchronous admission fail closed (C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { codexTurnIdentity } from "../../src/codex/accepted-turn.ts";
import { confirmNativeBoundary } from "../../src/core/simple/native-boundary.ts";
import {
  submissionAttempt,
  withSubmissionAttempt,
} from "../../src/core/simple/submission-context.ts";
import { runTurn } from "../../src/core/simple/turn.ts";
import { FakeTurnSession } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

test("C-API-48 custom native source without idle evidence cannot complete from ready or Stop", async () => {
  vi.useFakeTimers();
  const session = new FakeTurnSession();
  session.script = () => {
    submissionAttempt(session)?.beforeEnter("own");
    session.emit("status", { status: "running" });
    const accepted = { hook_event_name: "UserPromptSubmit", prompt: "own", turn_id: "owned" };
    session.emit("hook", accepted);
    confirmNativeBoundary(session, { kind: "stop", turnId: "owned", signal: "" });
    session.emit("status", { status: "ready" });
  };
  const turn = runTurn(session, "own", {
    readNativeTurn: codexTurnIdentity,
    timeoutMs: 100,
    fallbackQuietMs: 10,
  });
  const result = (async () => {
    for await (const event of turn.events) void event;
  })().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: "wait_timeout" });
    expect(session.listenerCount()).toBeGreaterThan(0); // Unknown work retains the boundary.
  } finally {
    session.emit("status", { status: "stopped" });
    await turn.boundary;
    await turn.completion;
  }
  expect(session.listenerCount()).toBe(0);
});

test("C-API-48 throwing nested admission restores the enclosing physical submission scope", () => {
  const session = {};
  const writes: string[] = [];
  const outer = { beforeEnter: (text: string) => writes.push(`outer:${text}`) };
  const inner = { beforeEnter: (text: string) => writes.push(`inner:${text}`) };
  withSubmissionAttempt(session, outer, () => {
    expect(() =>
      withSubmissionAttempt(session, inner, () => {
        submissionAttempt(session)?.beforeEnter("nested");
        throw new Error("nested admission rejected");
      }),
    ).toThrow("nested admission rejected");
    submissionAttempt(session)?.beforeEnter("original");
  });
  expect(writes).toEqual(["inner:nested", "outer:original"]);
  expect(submissionAttempt(session)).toBeUndefined();
});
