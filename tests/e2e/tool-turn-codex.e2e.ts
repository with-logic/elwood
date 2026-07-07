/**
 * Real Codex tool-use turns, persona delivery, and kill flows.
 * Implements C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type CodexHookHandlers,
  type CodexSession,
  ElwoodError,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  pathRemoved,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

type ToolSeen = { readonly name: string; readonly input: unknown; readonly response?: unknown };
test("C-E2E-03 real Codex turn queues early messages and hooks real tools", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSession | undefined;
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
    await waitFor(
      () =>
        prompts.some((p) => p.includes("shell tool") && p.includes("ELWOOD_CODEX_TOOL_OK"))
          ? true
          : undefined,
      "persona delivered as first UserPromptSubmit",
    );
    assert.ok(prompts[0]?.includes("ELWOOD_CODEX_TOOL_OK"), "persona is the first prompt");
    await waitFor(() => (preTools.length > 0 ? true : undefined), "real Codex PreToolUse");
    await waitFor(() => (postTools.length > 0 ? true : undefined), "real Codex PostToolUse");
    const pre = preTools[0];
    assert.ok(pre && pre.name.length > 0);
    assert.ok(pre.input && typeof pre.input === "object");
    await waitFor(() => (stops >= 1 ? true : undefined), "Codex Stop");
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
