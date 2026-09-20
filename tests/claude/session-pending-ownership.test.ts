/** Pending launch transactions preserve live predecessor guarantees (C-API-20/C-LOOP-17). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  currentClaudeHookBridgeFactory,
  setHookBridgeFactoryForTests,
} from "../../src/claude/session/bridge.ts";
import { type ClaudeSessionApi, resumeClaude, startClaude } from "../../src/index.ts";
import { readLoopDefinitions } from "../../src/state/loop-store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

async function becomeReady(id: string, cwd: string) {
  await ptys[0]!.dispatchHook(id, {
    hook_event_name: "SessionStart",
    session_id: "claude-1",
    cwd,
    source: "startup",
  });
}

function holdNextBridge(fail = false) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const factory = currentClaudeHookBridgeFactory();
  setHookBridgeFactoryForTests((...args) => {
    const bridge = factory(...args);
    return {
      start: async () => {
        await bridge.start();
        reached.resolve();
        await release.promise;
        if (fail) throw new Error("pending bridge failed");
      },
      stop: bridge.stop.bind(bridge),
    };
  });
  return { reached: reached.promise, release: release.resolve };
}

test("C-LOOP-17 pending successor activation preserves successful predecessor loop mutations", async () => {
  installFakes();
  const cwd = tempDir();
  const prior = await startClaude({ cwd });
  let current: ClaudeSessionApi | undefined;
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<ClaudeSessionApi> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    const loop = await prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "cancel" });
    held = holdNextBridge();
    starting = resumeClaude({ cwd, elwoodSessionId: prior.elwoodSessionId });
    await held.reached;
    await prior.cancelLoop(loop.id);
    expect(readLoopDefinitions(join(cwd, ".elwood"), prior.elwoodSessionId)).toEqual([]);
    const replacement = await prior.createLoop({
      mode: "fixed",
      intervalMs: 60_000,
      message: "replacement",
    });
    held.release();
    current = await starting;
    expect(await current.listLoops()).toEqual([expect.objectContaining({ id: replacement.id })]);
  } finally {
    held?.release();
    current ??= await starting?.catch(() => undefined);
    await current?.teardown();
    await prior.teardown();
  }
});

test.each([
  "kill",
  "teardown",
] as const)("C-API-20 %s during failed pending resume finishes its destructive cleanup", async (verb) => {
  installFakes();
  const cwd = tempDir();
  const prior = await startClaude({ cwd });
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<unknown> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    await prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "remove" });
    held = holdNextBridge(true);
    starting = resumeClaude({ cwd, elwoodSessionId: prior.elwoodSessionId }).catch(
      (error: unknown) => error,
    );
    await held.reached;
    const stopped = prior[verb]();
    expect(ptys[0]!.killSignals).not.toEqual([]);
    held.release();
    expect(await starting).toMatchObject({ code: "hook_bridge_failed" });
    await stopped;
    const stateDir = join(cwd, ".elwood");
    expect(readLoopDefinitions(stateDir, prior.elwoodSessionId)).toEqual([]);
    if (verb === "teardown")
      expect(existsSync(join(stateDir, "sessions", prior.elwoodSessionId))).toBe(false);
  } finally {
    held?.release();
    await starting;
    await prior.teardown();
  }
});

test("C-HRESP-07 a pending successor cannot replace the live predecessor's deny hook", async () => {
  installFakes();
  const cwd = tempDir();
  const prior = await startClaude({
    cwd,
    hooks: { PreToolUse: () => ({ permissionDecision: "deny", permissionDecisionReason: "held" }) },
  });
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<unknown> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    held = holdNextBridge(true);
    starting = resumeClaude({ cwd, elwoodSessionId: prior.elwoodSessionId }).catch(
      (error: unknown) => error,
    );
    await held.reached;
    const reply = await ptys[0]!.dispatchHook(prior.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      turn_id: "pending-turn",
      tool_name: "Bash",
      tool_input: { command: "echo held" },
      tool_use_id: "pending-policy",
    });
    expect(reply.stdout).toContain('"permissionDecision":"deny"');
  } finally {
    held?.release();
    await starting;
    await prior.teardown();
  }
});
