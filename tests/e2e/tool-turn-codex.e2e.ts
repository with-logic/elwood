/**
 * Real Codex tool-use turns, persona delivery, and kill flows.
 * Implements C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type CodexHookHandlers,
  type CodexSessionApi,
  type ElwoodActivityEvent,
  ElwoodError,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  pathRemoved,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

type ToolSeen = { readonly name: string; readonly input: unknown; readonly response?: unknown };
test("C-E2E-03 real Codex turn queues early messages and hooks real tools", {
  skip: skipIf(skipReason("codex"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSessionApi | undefined;
  const prompts: string[] = [];
  const preTools: ToolSeen[] = [];
  const postTools: ToolSeen[] = [];
  let stops = 0;
  const hooks: CodexHookHandlers = {
    UserPromptSubmit: (event) => {
      prompts.push(event.prompt);
    },
    PreToolUse: (event) => {
      preTools.push({ name: String(event.tool_name), input: event.tool_input });
      return undefined;
    },
    PostToolUse: (event) => {
      postTools.push({ name: String(event.tool_name), input: event.tool_input });
    },
    Stop: () => {
      stops += 1;
    },
  };
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      sandbox: "workspace-write",
      approvalPolicy: "never",
      hookTimeoutMs: 10_000,
      autotrust: true,
      // The persona is delivered by Elwood as the queued first message.
      persona:
        "Run `cat AGENTS.md` with your shell tool.\nThen reply exactly: ELWOOD_CODEX_TOOL_OK",
      hooks,
    });
    const observed = observeSession(session);
    // C-E2E-11: the queued initial persona is DELIVERED (observed as the first
    // UserPromptSubmit), not swallowed — the queue is released on Codex's
    // SessionStart hook, not the boot-time composer placeholder (C-API-28).
    // This is the exact "initial prompt submitted before Codex was ready" failure a
    // host application reported: if readiness fired early, no UserPromptSubmit would arrive.
    await waitFor(
      () =>
        prompts.some((p) => p.includes("shell tool") && p.includes("ELWOOD_CODEX_TOOL_OK"))
          ? true
          : undefined,
      "C-E2E-11 persona delivered as first UserPromptSubmit",
    );
    assert.ok(prompts[0]?.includes("ELWOOD_CODEX_TOOL_OK"), "persona is the first prompt");
    await waitFor(() => (preTools.length > 0 ? true : undefined), "real Codex PreToolUse");
    await waitFor(() => (postTools.length > 0 ? true : undefined), "real Codex PostToolUse");
    const pre = preTools[0];
    assert.ok(pre && pre.name.length > 0);
    assert.ok(pre.input && typeof pre.input === "object");
    await waitFor(() => (stops >= 1 ? true : undefined), "Codex Stop");
    // C-E2E-10: the committed reply surfaces as exactly one assistant_message,
    // sourced from the transcript — never a second copy re-projected from the
    // Stop hook's last_assistant_message (C-CODEX-16). Regression guard for the
    // "Codex replies received twice" report from a host application.
    await waitFor(
      () => (assistantMessages(observed.activities).length >= 1 ? true : undefined),
      "Codex assistant_message activity",
    );
    const replies = assistantMessages(observed.activities);
    assert.equal(replies.length, 1, "reply surfaces exactly once, not doubled");
    assert.equal(replies[0]?.source, "transcript", "assistant_message is transcript-sourced");
    assert.ok(
      !replies.some((a) => a.source === "hook"),
      "no assistant_message re-projected from the Stop hook",
    );
    const replayed: string[] = [];
    session.on("terminal:data", (event) => replayed.push(event.data))();
    assert.ok(replayed.join("").length > 0, "late subscriber receives replayed terminal data");
    assert.equal(observed.hookErrors.length, 0);
    await session.kill();
    assert.equal(session.status, "killed");
    assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), false);
    const killedCodex = session;
    await assert.rejects(
      async () => killedCodex.sendMessage("late"),
      hasCode("session_not_running"),
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ElwoodError && error.code === code;
}

/** The committed persona reply, projected as `assistant_message` activity. */
function assistantMessages(
  activities: readonly ElwoodActivityEvent[],
): readonly ElwoodActivityEvent[] {
  return activities.filter(
    (event) =>
      event.kind === "assistant_message" && (event.text ?? "").includes("ELWOOD_CODEX_TOOL_OK"),
  );
}
