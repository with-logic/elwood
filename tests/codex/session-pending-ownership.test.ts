/** Pending launch transactions preserve live predecessor guarantees (C-API-20/C-LOOP-17). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  currentCodexHookBridgeFactory,
  setCodexHookBridgeFactoryForTests,
} from "../../src/codex/session/bridge.ts";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { readLoopDefinitions } from "../../src/state/loop-store.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

function holdNextBridge(fail = false) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const factory = currentCodexHookBridgeFactory();
  setCodexHookBridgeFactoryForTests((...args) => {
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
  const prior = await startCodex({ cwd });
  let current: CodexSessionApi | undefined;
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<CodexSessionApi> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    const loop = await prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "cancel" });
    held = holdNextBridge();
    starting = resumeCodex({ cwd, elwoodSessionId: prior.elwoodSessionId });
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
  const prior = await startCodex({ cwd });
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<unknown> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    await prior.createLoop({ mode: "fixed", intervalMs: 60_000, message: "remove" });
    held = holdNextBridge(true);
    starting = resumeCodex({ cwd, elwoodSessionId: prior.elwoodSessionId }).catch(
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
  const prior = await startCodex({
    cwd,
    hooks: { PreToolUse: () => ({ permissionDecision: "deny", permissionDecisionReason: "held" }) },
  });
  let held: ReturnType<typeof holdNextBridge> | undefined;
  let starting: Promise<unknown> | undefined;
  try {
    await becomeReady(prior.elwoodSessionId, cwd);
    held = holdNextBridge(true);
    starting = resumeCodex({ cwd, elwoodSessionId: prior.elwoodSessionId }).catch(
      (error: unknown) => error,
    );
    await held.reached;
    const reply = await ptys[0]!.dispatchHook(prior.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "codex-1",
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
