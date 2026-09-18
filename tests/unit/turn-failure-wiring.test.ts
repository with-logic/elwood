/**
 * Coverage that the SHIPPED session classes actually wire their turn-failure readers
 * (PRD §5.8/§12A.5, C-API-57, C-CLI-28). `turn-failure.test.ts` proves each reader and the
 * runner in isolation — by passing the readers explicitly — so it would still pass if a class
 * forgot to install one. These tests drive `CodexSession`, `ClaudeSession`, and the headless
 * CLI facade themselves, with only the underlying launch faked, so the wiring is what is under
 * test: a rejected turn must fail rather than resolve as an empty success.
 */

import { describe, expect, test } from "vitest";
import { ClaudeSession } from "../../src/claude/simple.ts";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { CodexSession } from "../../src/codex/simple.ts";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { activity, FakeUnderlying } from "./simple-fakes.ts";

/** The real Codex rejection shape: a transcript `task_complete` carrying an `error`. */
const codexRejection = {
  type: "event_msg",
  payload: {
    type: "task_complete",
    last_agent_message: null,
    error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" },
  },
};

/** A turn the agent REJECTS the Codex way: transcript evidence, and NO `Stop` hook at all. */
function codexRejectedTurn(underlying: FakeUnderlying): void {
  underlying.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    emitter.emit(
      "activity",
      activity({ agent: "codex", kind: "other", label: "task_complete", raw: codexRejection }),
    );
    emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  };
}

/** A turn the agent REJECTS the Claude way: a `StopFailure` boundary hook. */
function claudeRejectedTurn(underlying: FakeUnderlying): void {
  underlying.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
    // `hook` is an adapter event rather than a common one; the session forwards it verbatim.
    (emitter as unknown as { emit: (e: string, p: unknown) => void }).emit("hook", {
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "You have exceeded your rate limit.",
    });
    emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  };
}

/** Replace a session's lazy launch with a fake underlying session. */
function stubLaunch(session: object, underlying: FakeUnderlying): void {
  (session as { launch: () => Promise<ElwoodAgentSession> }).launch = () =>
    Promise.resolve(underlying);
}

describe("C-API-57 the shipped session classes fail a rejected turn", () => {
  test("CodexSession.send rejects with turn_failed on transcript evidence", async () => {
    const underlying = new FakeUnderlying();
    codexRejectedTurn(underlying);
    const session = new CodexSession({ cwd: "/fake" });
    stubLaunch(session, underlying);
    await expect(session.send("go")).rejects.toMatchObject({
      code: "turn_failed",
      message: "You've hit your usage limit.",
    });
  });

  test("ClaudeSession.send rejects with turn_failed on a StopFailure hook", async () => {
    const underlying = new FakeUnderlying();
    claudeRejectedTurn(underlying);
    const session = new ClaudeSession({ cwd: "/fake" });
    stubLaunch(session, underlying);
    await expect(session.send("go")).rejects.toMatchObject({
      code: "turn_failed",
      message: "You have exceeded your rate limit.",
    });
  });

  test("C-CLI-28 the headless CLI facade fails a rejected Codex turn", async () => {
    // This is the exact shape #19 reported: `elwood --agent=codex` exiting 0 with empty output.
    const underlying = new FakeUnderlying();
    codexRejectedTurn(underlying);
    const request = { agent: "codex", cwd: "/fake", stateDir: "/fake/.state" };
    const session = new HeadlessCliSession(request as EffectiveRunRequest, "s1", () =>
      Promise.resolve(underlying),
    );
    await expect(session.send("go")).rejects.toMatchObject({ code: "turn_failed" });
  });

  test("§12A.3 a legitimately EMPTY turn still succeeds through the shipped classes", async () => {
    // The guard against the obvious wrong fix: no assistant text, a null `last_agent_message`,
    // and a `task_complete` WITHOUT an error is a successful empty response, not a failure.
    const underlying = new FakeUnderlying();
    underlying.script = (emitter) => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit(
        "activity",
        activity({
          agent: "codex",
          kind: "other",
          label: "task_complete",
          raw: { type: "event_msg", payload: { type: "task_complete", last_agent_message: null } },
        }),
      );
      // A real empty turn still reaches its `Stop` boundary (that is what makes it a SUCCESS
      // with no text, rather than the hook-less rejection above).
      (emitter as unknown as { emit: (e: string, p: unknown) => void }).emit("hook", {
        hook_event_name: "Stop",
        last_assistant_message: null,
      });
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    };
    const session = new CodexSession({ cwd: "/fake" });
    stubLaunch(session, underlying);
    expect(await session.send("go")).toBe("");
  });
});
